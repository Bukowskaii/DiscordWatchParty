import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { getGuildConfig, saveGuildConfig, deleteGuildConfig } from '../../store/guild-config';
import { invalidateProvider } from '../../providers';
import { setupData as data } from './definitions';

export { data };

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
  const result = await testConnection(provider, url, credential);
  if (!result.ok) {
    await interaction.editReply(
      `Could not reach **${url}** with the credentials provided.\n` +
      `- Check the URL is accessible from this server\n` +
      `- Verify your ${credentialLabel} is correct`,
    );
    return;
  }

  const resolvedUrl = result.resolvedUrl;
  saveGuildConfig(interaction.guildId!, provider, resolvedUrl, credential);
  invalidateProvider(interaction.guildId!);

  const providerName = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' }[provider];
  const urlNote = resolvedUrl !== url
    ? `\n-# URL was automatically updated to \`${resolvedUrl}\` (redirected from \`${url}\`)`
    : '';
  await interaction.editReply(
    `Connected to **${providerName}** at \`${resolvedUrl}\`. Members can now use \`/play\` to start a watch party.${urlNote}`,
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
): Promise<{ ok: boolean; resolvedUrl: string }> {
  try {
    let response;
    if (provider === 'plex') {
      response = await axios.get(`${url}/identity`, {
        params: { 'X-Plex-Token': apiKey },
        timeout: 8_000,
      });
    } else {
      response = await axios.get(`${url}/System/Info`, {
        headers: { 'X-Emby-Token': apiKey },
        timeout: 8_000,
      });
    }

    // axios (via follow-redirects) exposes the final URL after any redirects.
    // Use it to capture an http→https upgrade so we store the canonical URL.
    const finalUrl: string | undefined = response.request?.res?.responseUrl;
    let resolvedUrl = url;
    if (finalUrl) {
      const parsed = new URL(finalUrl);
      resolvedUrl = `${parsed.protocol}//${parsed.host}`;
    }
    return { ok: true, resolvedUrl };
  } catch {
    return { ok: false, resolvedUrl: url };
  }
}
