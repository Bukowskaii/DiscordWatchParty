/**
 * Run once after adding/changing slash commands:
 *   npm run deploy-commands
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { commandsJSON } from './commands/index';

const rest = new REST().setToken(config.discord.token);

(async () => {
  console.log(`Registering ${commandsJSON.length} slash commands…`);
  await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commandsJSON });
  console.log('Done.');
})();
