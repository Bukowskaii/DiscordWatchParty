/**
 * Run once after adding/changing slash commands:
 *   npm run deploy-commands
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import {
  setupData, playData, searchData, queueData, pauseData, resumeData, skipData, stopData,
} from './commands/definitions';

const rest = new REST().setToken(config.discord.token);

const commands = [setupData, playData, searchData, queueData, pauseData, resumeData, skipData, stopData];

(async () => {
  const body = commands.map(c => c.toJSON());
  const { clientId, guildId } = config.discord;

  if (guildId) {
    console.log(`Registering ${commands.length} slash commands to guild ${guildId} (instant)…`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    // Clear any previously-registered global commands so they don't show up as
    // duplicates alongside the guild-scoped ones.
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('Cleared global commands to avoid duplicates.');
  } else {
    console.log(`Registering ${commands.length} global slash commands (up to ~1h to propagate)…`);
    await rest.put(Routes.applicationCommands(clientId), { body });
  }
  console.log('Done.');
})();
