/** /spike slash command definition (THROWAWAY spike). */
import { SlashCommandBuilder } from "discord.js";

export const spikeCommand = new SlashCommandBuilder()
  .setName("spike")
  .setDescription("S02 capture spike (throwaway)")
  .addSubcommand((s) => s.setName("start").setDescription("Join the configured voice channel and record opted-in users"))
  .addSubcommand((s) => s.setName("stop").setDescription("Finalize fragments and leave"))
  .addSubcommand((s) =>
    s
      .setName("mark")
      .setDescription("Log a reference timestamp (and play a beep if enabled)")
      .addStringOption((o) => o.setName("label").setDescription("Mark label").setRequired(false)),
  )
  .addSubcommand((s) => s.setName("reconnect").setDescription("Force a full voice reconnect (bot reconnect case)"));
