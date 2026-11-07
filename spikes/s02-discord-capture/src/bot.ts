/**
 * Discord wiring for the S02 spike (THROWAWAY, not production; never run by CI or tests).
 * discord.js 14 + @discordjs/voice 0.19 (DAVE via @snazzah/davey, daveEncryption: true).
 *
 * Slash commands (GM only): /spike start | stop | mark [label] | reconnect
 * Only users in the config allowlist are subscribed to; everyone else is never received/decoded.
 */
import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, Events, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction, type VoiceState } from "discord.js";
import { systemClock } from "./clock.js";
import { Allowlist, sessionParamsOf, type HarnessConfig } from "./config.js";
import { reportFailure } from "./interaction-reply.js";
import { beepOpusPackets, createOpusDecoder } from "./opus.js";
import { ReceiveSubscriptions } from "./receive-subscriptions.js";
import { CaptureSession, sessionIdFor } from "./session.js";

/** Console logger. Never pass the token or audio/transcript content here. */
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(`[s02 ${new Date().toISOString()}] ${msg}${Object.keys(fields).length ? " " + JSON.stringify(fields) : ""}`);
}

export class SpikeBot {
  readonly client: Client;
  private readonly allow: Allowlist;
  private session: CaptureSession | null = null;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private readonly streams = new ReceiveSubscriptions();
  private readonly beep = beepOpusPackets();

  constructor(private readonly cfg: HarnessConfig) {
    this.allow = new Allowlist(cfg.allowlist);
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client.once(Events.ClientReady, (c) => log("gateway ready", { bot_user: c.user.tag }));
    this.client.on(Events.InteractionCreate, (i) => {
      if (i.isChatInputCommand() && i.commandName === "spike") void this.onCommand(i);
    });
    this.client.on(Events.VoiceStateUpdate, (o, n) => this.onVoiceState(o, n));
  }

  /** Stops the session cleanly (used by SIGINT handler, /spike stop and failed starts). */
  shutdown(reason: string): void {
    const s = this.session;
    const conn = this.connection;
    // Clear the references first, so callbacks fired by stop/destroy see a stale session and do nothing.
    this.session = null;
    this.connection = null;
    this.player = null;
    this.streams.dropAll();
    s?.stop(reason);
    conn?.destroy();
  }

  private async onCommand(i: ChatInputCommandInteraction): Promise<void> {
    if (i.user.id !== this.cfg.gm_user_id || i.guildId !== this.cfg.guild_id) {
      await reportFailure(i, "Only the GM can control the S02 spike.", MessageFlags.Ephemeral);
      return;
    }
    const sub = i.options.getSubcommand();
    try {
      if (sub === "start") await this.start(i);
      else if (sub === "stop") await this.stop(i);
      else if (sub === "mark") await this.mark(i);
      else if (sub === "reconnect") await this.forceReconnect(i);
    } catch (e) {
      log("command failed", { sub, error: (e as Error).message });
      // start/reconnect defer their reply, so a failure must go through editReply (reply() would throw).
      const res = await reportFailure(i, `failed: ${(e as Error).message}`, MessageFlags.Ephemeral);
      if (res instanceof Error) log("could not report command failure", { sub, error: res.message });
    }
  }

  private async start(i: ChatInputCommandInteraction): Promise<void> {
    if (this.session) {
      await i.reply({ content: "Already recording.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    const s = new CaptureSession({
      outputRoot: this.cfg.output_root,
      sessionId: sessionIdFor(Date.now()),
      clock: systemClock,
      allowlist: this.allow,
      // Only the numeric session parameters, never the full config (gm_user_id, guild/channel ids, paths).
      params: sessionParamsOf(this.cfg),
      decoderFactory: createOpusDecoder,
    });
    this.session = s;
    s.event("start_command", { interaction_created_wall_ms: i.createdTimestamp });
    try {
      await this.connect();
    } catch (e) {
      // Leave no half-started recorder behind, so the GM can simply retry /spike start.
      s.event("start_failed", { message: (e as Error).message });
      if (this.session === s) this.shutdown("start_failed");
      throw e;
    }
    await i.editReply(
      `S02 spike recording ON. Only opted-in participants are recorded (${this.allow.labels().join(", ")}). ` +
        `Everyone else is not received. Use /spike stop to end.`,
    );
    log("session started", { dir: s.dir });
  }

  private async connect(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.cfg.guild_id);
    const conn = joinVoiceChannel({
      guildId: this.cfg.guild_id,
      channelId: this.cfg.voice_channel_id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
      decryptionFailureTolerance: this.cfg.dave_decryption_failure_tolerance,
      debug: true,
    });
    this.connection = conn;
    this.streams.dropAll();
    conn.on("stateChange", (o, n) => this.onConnState(conn, o.status, n.status));
    conn.on("error", (e) => {
      if (conn === this.connection) this.session?.event("connection_error", { message: e.message });
    });
    conn.on("transitioned", (id) => {
      if (conn === this.connection) this.session?.event("dave_transitioned", { transition_id: id });
    });
    conn.on("debug", (m) => {
      if (conn === this.connection && /dave|decrypt|mls|epoch/i.test(m)) this.session?.event("voice_debug", { message: m.slice(0, 300) });
    });
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
    } catch (e) {
      // Never keep a connection that did not reach Ready (no receive listener or player installed on it).
      if (this.connection === conn) this.connection = null;
      conn.destroy();
      throw e;
    }
    if (this.connection !== conn) throw new Error("voice connection was replaced or stopped while connecting");
    conn.receiver.speaking.on("start", (userId) => this.subscribe(conn, userId));
    this.player = createAudioPlayer();
    conn.subscribe(this.player);
  }

  private onConnState(conn: VoiceConnection, from: VoiceConnectionStatus, to: VoiceConnectionStatus): void {
    const s = this.session;
    if (!s || conn !== this.connection) return;
    s.event("connection_state", { from, to });
    if (from === VoiceConnectionStatus.Ready && to !== VoiceConnectionStatus.Ready) {
      // Destroy (not just forget) the receive streams: in voice 0.19.2 subscribe() hands back a still-alive
      // stream, and a second data listener on it would decode/write every packet twice.
      this.streams.dropAll();
      s.beginDiscontinuity(`connection ${from}->${to}`);
    }
    if (to === VoiceConnectionStatus.Ready && from !== VoiceConnectionStatus.Ready) s.endDiscontinuity();
    if (to === VoiceConnectionStatus.Disconnected) {
      // Standard discord.js recovery: if it does not start reconnecting within 5 s, rejoin explicitly.
      void Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        // The GM may have stopped or forced a full reconnect during the wait: only act if this session and
        // connection are still current and the connection is still Disconnected.
        if (this.session !== s || this.connection !== conn) return;
        if (conn.state.status !== VoiceConnectionStatus.Disconnected) return;
        s.event("rejoin_attempt", {});
        try {
          conn.rejoin();
        } catch (e) {
          s.event("rejoin_failed", { message: (e as Error).message });
        }
      });
    }
  }

  private subscribe(conn: VoiceConnection, userId: string): void {
    // Opt-in enforcement layer 1: never subscribe to a non-allowlisted user.
    if (!this.allow.isOptedIn(userId) || !this.session || conn !== this.connection || this.streams.has(userId)) return;
    const s = this.session;
    const stream = conn.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.cfg.silence_close_ms },
    });
    // Callbacks are bound to this specific stream; stale streams can never reach the session.
    this.streams.add(userId, stream, {
      onData: (pkt) => s.onPacket(userId, pkt, process.hrtime.bigint()),
      onEnd: () => s.onStreamEnd(userId),
      onError: (e) => s.event("receive_stream_error", { label: this.allow.labelOf(userId), message: e.message }),
    });
  }

  private async stop(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.session) {
      await i.reply({ content: "Not recording.", flags: MessageFlags.Ephemeral });
      return;
    }
    const dir = this.session.dir;
    this.session.event("stop_command", { interaction_created_wall_ms: i.createdTimestamp });
    this.shutdown("stop_command");
    await i.reply("S02 spike recording OFF.");
    log("session stopped", { dir });
  }

  private async mark(i: ChatInputCommandInteraction): Promise<void> {
    const s = this.session;
    if (!s) {
      await i.reply({ content: "Not recording.", flags: MessageFlags.Ephemeral });
      return;
    }
    const label = i.options.getString("label") ?? `m${Date.now()}`;
    const t = s.mark(label, { interaction_created_wall_ms: i.createdTimestamp, received_wall_ms: Date.now() });
    if (this.cfg.mark_beep && this.player) {
      const p = this.player;
      p.once(AudioPlayerStatus.Playing, () => s.event("mark_beep_playing", { label }));
      p.play(createAudioResource(Readable.from(this.beep), { inputType: StreamType.Opus }));
    }
    await i.reply({ content: `mark ${label} @ ${t} ms`, flags: MessageFlags.Ephemeral });
  }

  /** Deliberate full voice reconnect for the "bot reconnect" case: destroy + join again. */
  private async forceReconnect(i: ChatInputCommandInteraction): Promise<void> {
    const s = this.session;
    if (!s) {
      await i.reply({ content: "Not recording.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    s.event("forced_reconnect_command", {});
    this.streams.dropAll();
    s.beginDiscontinuity("forced_reconnect_command");
    const old = this.connection;
    this.connection = null;
    this.player = null;
    old?.destroy();
    // On failure connect() leaves no connection; the session stays in the discontinuity and the GM can
    // run /spike reconnect again (allowed without a connection) or /spike stop.
    await this.connect();
    if (this.session !== s) return; // stopped while reconnecting
    s.endDiscontinuity();
    await i.editReply("reconnected");
  }

  private onVoiceState(o: VoiceState, n: VoiceState): void {
    const s = this.session;
    if (!s) return;
    const ch = this.cfg.voice_channel_id;
    if (o.channelId !== ch && n.channelId !== ch) return;
    const userId = n.id;
    if (userId === this.client.user?.id) return;
    // Non-opted-in members: log that something happened, never who.
    const label = this.allow.labelOf(userId);
    const who = label ? { label } : { label: null, non_optin: true };
    if (o.channelId !== ch && n.channelId === ch) s.event("member_join", who);
    else if (o.channelId === ch && n.channelId !== ch) {
      s.event("member_leave", who);
      if (label) s.onStreamEnd(userId);
    } else {
      if (o.selfMute !== n.selfMute) s.event(n.selfMute ? "self_mute" : "self_unmute", who);
      if (o.serverMute !== n.serverMute) s.event(n.serverMute ? "server_mute" : "server_unmute", who);
      if (o.selfDeaf !== n.selfDeaf) s.event(n.selfDeaf ? "self_deaf" : "self_undeaf", who);
    }
  }
}
