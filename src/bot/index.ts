import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from '../config';
import { commands } from './commands/index';

export function startBot(): void {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, c => {
    console.log(`Discord bot ready — logged in as ${c.user.tag}`);
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const cmd = commands.get(interaction.commandName);
    if (!cmd) return;

    try {
      await cmd.execute(interaction);
    } catch (err) {
      console.error(`Command /${interaction.commandName} failed:`, err);
      const msg = { content: 'Something went wrong.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
  });

  client.login(config.discord.token);
}
