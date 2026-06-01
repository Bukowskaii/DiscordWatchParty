import { Client, GatewayIntentBits, Events, Guild, ApplicationCommandDataResolvable } from 'discord.js';
import { config } from '../config';
import { commands, commandsJSON } from './commands/index';
import { handleVoiceStateUpdate, cleanupOrphanChannels, startPartyReaper } from './party';

export function startBot(): void {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once(Events.ClientReady, async c => {
    console.log(`Discord bot ready — logged in as ${c.user.tag}`);

    // Register commands per-guild so updates are instant in every server the
    // bot is in. Clear global commands first so they don't appear as
    // duplicates alongside the guild-scoped ones.
    try {
      await c.application.commands.set([]);
    } catch (err) {
      console.error('Failed to clear global commands:', err);
    }
    for (const guild of c.guilds.cache.values()) {
      await registerGuildCommands(guild);
      await cleanupOrphanChannels(guild); // remove leftover empty party channels
    }
    console.log(`Registered commands in ${c.guilds.cache.size} guild(s).`);
    startPartyReaper(c);
  });

  // Register commands the moment the bot is added to a new server.
  client.on(Events.GuildCreate, guild => registerGuildCommands(guild));

  // Track who's in each party voice channel (drives the watch-page participant
  // list and empty-channel cleanup).
  client.on(Events.VoiceStateUpdate, (oldState, newState) => handleVoiceStateUpdate(oldState, newState));

  client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isAutocomplete()) {
      const cmd = commands.get(interaction.commandName);
      if (cmd?.autocomplete) {
        try {
          await cmd.autocomplete(interaction);
        } catch (err) {
          console.error(`Autocomplete for /${interaction.commandName} failed:`, err);
        }
      }
      return;
    }

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

async function registerGuildCommands(guild: Guild): Promise<void> {
  try {
    await guild.commands.set(commandsJSON as ApplicationCommandDataResolvable[]);
  } catch (err) {
    console.error(`Failed to register commands in guild ${guild.id} (${guild.name}):`, err);
  }
}
