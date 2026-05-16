/**
 * Run once after adding/changing slash commands:
 *   npm run deploy-commands
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import {
  setupData, playData, queueData, pauseData, resumeData, skipData, stopData,
} from './commands/definitions';

const rest = new REST().setToken(config.discord.token);

const commands = [setupData, playData, queueData, pauseData, resumeData, skipData, stopData];

(async () => {
  console.log(`Registering ${commands.length} slash commands…`);
  await rest.put(Routes.applicationCommands(config.discord.clientId), {
    body: commands.map(c => c.toJSON()),
  });
  console.log('Done.');
})();
