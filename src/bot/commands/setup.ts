import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import axios from 'axios';
import { getGuildConfig, saveGuildConfig, deleteGuildConfig } from '../../store/guild-config';
import { invalidateProvider } from '../../providers';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configure this server\'s media provider')
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
      ),
  )
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show current media server configuration'),
  )
  .addSubcommand(sub =>
    sub.setName('remove').setDescription('Remove this server\'s media server configuration'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') return handleStatus(interaction);
  if (sub === 'remove') return handleRemove(interaction);
  return handleConfigure(interaction);
}

// ── /setup configure ──────────────────────────────────────────────────────────

async function handleConfigure(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const provider = interaction.options.getString('provider', true) as 'plex' | 'jellyfin' | 'emby';
  const url = interaction.options.getString('url', true).replace(/\/$/, '');
  const token = interaction.options.getString('token');
  const apiKey = interaction.options.getString('api-key');

  // Validate required credential for the chosen provider
  const isPlex = provider === 'plex';
  const credential = isPlex ? token : apiKey;
  const credentialLabel = isPlex ? '`token`' : '`api-key`';

  if (!credential) {
    await interaction.editReply(
      `You must provide ${credentialLabel} for ${provider}.`,
    );
    return;
  }

  // Test the connection before saving
  await interaction.editReply('Testing connection to your media server…');
  const ok = await testConnection(provider, url, credential);
  if (!ok) {
    await interaction.editReply(
      `Could not reach **${url}** with the credentials provided.\n` +
      `- Check the URL is accessible from this server\n` +
      `- Verify your ${credentialLabel} is correct`,
    );
    return;
  }

  saveGuildConfig(interaction.guildId!, provider, url, credential);
  invalidateProvider(interaction.guildId!);

  const providerName = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' }[provider];
  await interaction.editReply(
    `Connected to **${providerName}** at \`${url}\`. Members can now use \`/play\` to start a watch party.`,
  );
}

// ── /setup status ─────────────────────────────────────────────────────────────

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const cfg = getGuildConfig(interaction.guildId!);

  if (!cfg) {
    await interaction.reply({
      content: 'No media server configured. Run `/setup configure` to get started.',
      ephemeral: true,
    });
    return;
  }

  const providerName = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' }[cfg.provider];
  const embed = new EmbedBuilder()
    .setTitle('Media server configuration')
    .addFields(
      { name: 'Provider', value: providerName, inline: true },
      { name: 'URL', value: cfg.mediaUrl, inline: true },
      { name: 'API key', value: '`' + cfg.apiKey.slice(0, 6) + '…`', inline: true },
      { name: 'Configured', value: `<t:${Math.floor(cfg.configuredAt / 1000)}:R>`, inline: true },
    )
    .setColor(0x5865f2);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── /setup remove ─────────────────────────────────────────────────────────────

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const removed = deleteGuildConfig(interaction.guildId!);
  invalidateProvider(interaction.guildId!);

  await interaction.reply({
    content: removed
      ? 'Media server configuration removed.'
      : 'No configuration found for this server.',
    ephemeral: true,
  });
}

// ── Connection test ───────────────────────────────────────────────────────────

async function testConnection(
  provider: 'plex' | 'jellyfin' | 'emby',
  url: string,
  apiKey: string,
): Promise<boolean> {
  try {
    if (provider === 'plex') {
      await axios.get(`${url}/identity`, {
        params: { 'X-Plex-Token': apiKey },
        timeout: 8_000,
      });
    } else {
      await axios.get(`${url}/System/Info`, {
        headers: { 'X-Emby-Token': apiKey },
        timeout: 8_000,
      });
    }
    return true;
  } catch {
    return false;
  }
}
