/**
 * Registers the guild-scoped /spike command (THROWAWAY). Human step: needs network + S02_DISCORD_TOKEN.
 * Usage: npm run register-commands -- [path/to/s02.config.json]
 */
import { REST, Routes } from "discord.js";
import { spikeCommand } from "./commands.js";
import { loadConfig, readToken } from "./config.js";

const cfg = loadConfig(process.argv[2] ?? "s02.config.json");
const rest = new REST().setToken(readToken());
await rest.put(Routes.applicationGuildCommands(cfg.application_id, cfg.guild_id), { body: [spikeCommand.toJSON()] });
console.log("registered /spike for guild", cfg.guild_id);
