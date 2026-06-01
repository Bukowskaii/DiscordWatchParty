import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export const setupData = new SlashCommandBuilder()
  .setName('setup')
  .setDescription("Configure this server's media provider")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub
      .setName('configure')
      .setDescription('Connect a Plex, Jellyfin, or Emby server')
      .addStringOption(opt =>
        opt
          .setName('provider')
          .setDescription('Which media server are you using?')
          .setRequired(true)
          .addChoices(
            { name: 'Plex', value: 'plex' },
            { name: 'Jellyfin', value: 'jellyfin' },
            { name: 'Emby', value: 'emby' },
          ),
      )
      .addStringOption(opt =>
        opt
          .setName('url')
          .setDescription('Base URL of your media server (e.g. http://192.168.1.x:32400)')
          .setRequired(true),
      )
      .addStringOption(opt =>
        opt
          .setName('token')
          .setDescription('Plex token — required for Plex')
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('api-key')
          .setDescription('API key — required for Jellyfin / Emby')
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('playback-user')
          .setDescription('Plex only: shared user name to play as (auto-fetches token). Use "none" to revert to admin.')
          .setRequired(false),
      )
      .addStringOption(opt =>
        opt
          .setName('playback-token')
          .setDescription('Plex only: paste a separate user token directly (alternative to playback-user)')
          .setRequired(false),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show current media server configuration'),
  )
  .addSubcommand(sub =>
    sub.setName('remove').setDescription("Remove this server's media server configuration"),
  );

export const playData = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Search your media server and add to the queue')
  .addStringOption(opt =>
    opt.setName('query').setDescription('Title to search for').setRequired(true).setAutocomplete(true),
  );

export const searchData = new SlashCommandBuilder()
  .setName('search')
  .setDescription('Search your library and preview a result before queueing')
  .addStringOption(opt =>
    opt.setName('query').setDescription('Title to search for').setRequired(true).setAutocomplete(true),
  );

export const queueData = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current playback queue');

export const pauseData = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause playback for everyone');

export const resumeData = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume playback for everyone');

export const skipData = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip to the next item in the queue');

export const stopData = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback and clear the queue');
