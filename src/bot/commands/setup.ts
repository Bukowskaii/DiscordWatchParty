import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { getGuildConfig, saveGuildConfig, deleteGuildConfig } from '../../store/guild-config';
import { invalidateProvider } from '../../providers';
import { fetchPlaybackToken } from '../../providers/plex';
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
  const playbackTokenInput = interaction.options.getString('playback-token');
  const playbackUser = interaction.options.getString('playback-user');

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

  // Playback identity (Plex only): a pasted token wins; otherwise look up a
  // Home user by name and auto-fetch their token. If neither is given, keep
  // any previously-configured playback token/user.
  const existing = getGuildConfig(interaction.guildId!);
  let playbackToken: string | null | undefined = existing?.playbackToken;
  let playbackUserName: string | null | undefined = existing?.playbackUser;

  const clearPlayback =
    (playbackUser ?? playbackTokenInput ?? '').trim().toLowerCase() === 'none';

  if (isPlex && clearPlayback) {
    // Escape hatch: revert to playing under the admin account.
    playbackToken = null;
    playbackUserName = null;
  } else if (isPlex && playbackTokenInput) {
    // Validate the token actually has library access (auth-checked endpoint).
    if (!(await tokenHasAccess('plex', resolvedUrl, playbackTokenInput))) {
      await interaction.editReply(
        'Connected, but the **playback-token** cannot access your libraries (got an auth error). ' +
        'Make sure that user is shared into your server, then try again.',
      );
      return;
    }
    playbackToken = playbackTokenInput;
    playbackUserName = playbackUser ?? '(token provided directly)';
  } else if (isPlex && playbackUser) {
    await interaction.editReply(`Connected. Looking up shared user **${playbackUser}**…`);
    const resolved = await fetchPlaybackToken(credential, resolvedUrl, playbackUser);
    if (!resolved) {
      await interaction.editReply(
        `Connected, but couldn't find a share for **${playbackUser}** on this server.\n` +
        '- The name must match a user this server is shared with (managed Home user or invited account)\n' +
        '- Make sure that user has at least one library shared from **Settings → Users & Sharing**\n' +
        '- The admin `token` must be the server owner',
      );
      return;
    }
    if (!(await tokenHasAccess('plex', resolvedUrl, resolved))) {
      await interaction.editReply(
        `Found **${playbackUser}**, but their access token was rejected by the server. ` +
        'Re-check the libraries shared with them in Plex, then try again.',
      );
      return;
    }
    playbackToken = resolved;
    playbackUserName = playbackUser;
  }

  saveGuildConfig(interaction.guildId!, provider, resolvedUrl, credential, playbackToken, playbackUserName);
  invalidateProvider(interaction.guildId!);

  const providerName = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' }[provider];
  const urlNote = resolvedUrl !== url
    ? `\n-# URL was automatically updated to \`${resolvedUrl}\` (redirected from \`${url}\`)`
    : '';
  const playbackNote = isPlex && playbackToken
    ? `\n-# Playback will be attributed to **${playbackUserName ?? 'a dedicated user'}**.`
    : '';
  await interaction.editReply(
    `Connected to **${providerName}** at \`${resolvedUrl}\`. Members can now use \`/play\` to start a watch party.${urlNote}${playbackNote}`,
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

  await interaction.deferReply({ ephemeral: true });

  // Live-check both tokens against an auth-required endpoint so the status
  // reflects whether they actually work right now (not just that they're set).
  const adminOk = await tokenHasAccess(cfg.provider, cfg.mediaUrl, cfg.apiKey);

  let playbackValue: string;
  let playbackOk = true;
  if (!cfg.playbackToken) {
    playbackValue = 'Main account (admin token)';
  } else {
    const who = cfg.playbackUser ?? '(name not recorded)';
    playbackOk = await tokenHasAccess(cfg.provider, cfg.mediaUrl, cfg.playbackToken);
    playbackValue =
      `**${who}**\n` +
      `token \`${cfg.playbackToken.slice(0, 6)}…\` (${cfg.playbackToken.length} chars)\n` +
      `${playbackOk ? '✅ token works' : '❌ token rejected — playback will 403'}`;
  }

  const providerName = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby' }[cfg.provider];
  const allOk = adminOk && playbackOk;
  const embed = new EmbedBuilder()
    .setTitle('Media server configuration')
    .addFields(
      { name: 'Provider', value: providerName, inline: true },
      { name: 'URL', value: cfg.mediaUrl, inline: true },
      { name: 'Configured', value: `<t:${Math.floor(cfg.configuredAt / 1000)}:R>`, inline: true },
      { name: 'Admin token', value: `\`${cfg.apiKey.slice(0, 6)}…\` ${adminOk ? '✅ works' : '❌ rejected'}`, inline: false },
      { name: 'Playback identity', value: playbackValue, inline: false },
    )
    .setColor(allOk ? 0x57f287 : 0xed4245);

  await interaction.editReply({ embeds: [embed] });
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

// ── Token access check ────────────────────────────────────────────────────────
// Unlike the connection test (which hits Plex's unauthenticated /identity),
// this calls an endpoint that REQUIRES a valid token, so it actually verifies
// the credential can access libraries — i.e. that playback won't 403.

async function tokenHasAccess(
  provider: 'plex' | 'jellyfin' | 'emby',
  url: string,
  token: string,
): Promise<boolean> {
  try {
    if (provider === 'plex') {
      const res = await axios.get(`${url}/library/sections`, {
        params: { 'X-Plex-Token': token },
        timeout: 8_000,
        validateStatus: () => true,
      });
      return res.status === 200;
    }
    const res = await axios.get(`${url}/Library/MediaFolders`, {
      headers: { 'X-Emby-Token': token },
      timeout: 8_000,
      validateStatus: () => true,
    });
    return res.status === 200;
  } catch {
    return false;
  }
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
