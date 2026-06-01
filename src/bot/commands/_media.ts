import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  Message,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { getProviderForGuild } from '../../providers';
import type { MediaItem } from '../../providers';
import { addToQueue, createSession, setGuildName } from '../../rooms/manager';
import type { Room } from '../../rooms/manager';
import { resolvePartyRoom } from '../party';
import { config } from '../../config';

const PICK_TIMEOUT_MS = 60_000;

export function displayTitle(item: MediaItem): string {
  if (item.grandparentTitle) {
    return `${item.grandparentTitle} S${item.parentIndex ?? '?'}E${item.index ?? '?'} – ${item.title}`;
  }
  if (item.type === 'season' && item.index != null) {
    return item.title || `Season ${item.index}`;
  }
  return item.year ? `${item.title} (${item.year})` : item.title;
}

export function fmtDuration(ms: number): string {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Short, ≤100-char description for a select-menu option. */
function describe(item: MediaItem): string {
  const bits: string[] = [];
  const typeLabel: Record<string, string> = {
    movie: 'Movie', show: 'TV Show', season: 'Season', episode: 'Episode', track: 'Track',
  };
  bits.push(typeLabel[item.type] ?? item.type);
  if (item.year) bits.push(String(item.year));
  const dur = fmtDuration(item.duration);
  if (dur) bits.push(dur);
  return bits.join(' • ').slice(0, 100);
}

function isContainer(item: MediaItem): boolean {
  return item.type === 'show' || item.type === 'season';
}

/**
 * Presents media items in a select menu, drilling into shows/seasons until a
 * playable item is chosen. With `autoQueue`, the final item is queued
 * immediately; otherwise a detail card with an "Add to queue" button is shown.
 */
export async function runPicker(opts: {
  interaction: ChatInputCommandInteraction;
  guildId: string;
  items: MediaItem[];
  prompt: string;
  autoQueue: boolean;
  /** Resolves (creating if needed) the watch-party room to queue into. */
  resolveRoom: () => Promise<Room | null>;
}): Promise<void> {
  const { interaction, guildId, autoQueue, resolveRoom } = opts;
  const provider = getProviderForGuild(guildId);
  if (!provider) {
    await interaction.editReply('No media server configured.');
    return;
  }

  const queueInto = async (id: string): Promise<void> => {
    const room = await resolveRoom();
    if (!room) {
      await interaction.editReply({
        content: 'Could not create a watch-party voice channel — make sure I have the **Manage Channels** permission.',
        components: [], embeds: [],
      });
      return;
    }
    await enqueueById(interaction, room, id);
  };

  const resolve = async (item: MediaItem): Promise<void> => {
    const full = (await provider.getMetadata(item.id)) ?? item;
    if (isContainer(full) && provider.getChildren) {
      const children = await provider.getChildren(full.id);
      if (children.length) {
        await present(children, `**${displayTitle(full)}** — pick one:`);
        return;
      }
    }
    if (autoQueue) {
      await queueInto(full.id);
    } else {
      await showDetail(interaction, guildId, full, queueInto);
    }
  };

  const present = async (items: MediaItem[], prompt: string): Promise<void> => {
    if (items.length === 0) {
      await interaction.editReply({ content: 'Nothing to show here.', components: [] });
      return;
    }
    if (items.length === 1) {
      await resolve(items[0]);
      return;
    }

    const pageSize = 25;
    const pages = Math.ceil(items.length / pageSize);
    let page = 0;

    const render = (): ActionRowBuilder<MessageActionRowComponentBuilder>[] => {
      const slice = items.slice(page * pageSize, page * pageSize + pageSize);
      const menu = new StringSelectMenuBuilder()
        .setCustomId('media_pick')
        .setPlaceholder(pages > 1 ? `Choose… (page ${page + 1}/${pages})` : 'Choose…')
        .addOptions(
          slice.map(it => ({
            label: displayTitle(it).slice(0, 100),
            value: it.id,
            description: describe(it) || undefined,
          })),
        );
      const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu),
      ];
      if (pages > 1) {
        const prev = new ButtonBuilder().setCustomId('media_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0);
        const next = new ButtonBuilder().setCustomId('media_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1);
        rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(prev, next));
      }
      return rows;
    };

    const reply = (await interaction.editReply({ content: prompt, embeds: [], components: render() })) as Message;

    const chosen = await new Promise<MediaItem | null>(resolveP => {
      const collector = reply.createMessageComponentCollector({ time: PICK_TIMEOUT_MS });
      collector.on('collect', async i => {
        try {
          if (i.isButton()) {
            if (i.customId === 'media_prev') page = Math.max(0, page - 1);
            else if (i.customId === 'media_next') page = Math.min(pages - 1, page + 1);
            await i.update({ components: render() });
            collector.resetTimer();
          } else if (i.isStringSelectMenu()) {
            await i.deferUpdate();
            const sel = items.find(x => x.id === i.values[0]) ?? null;
            collector.stop('picked');
            resolveP(sel);
          }
        } catch { /* interaction race — ignore */ }
      });
      collector.on('end', (_collected, reason) => {
        if (reason !== 'picked') resolveP(null);
      });
    });

    if (!chosen) {
      await interaction.editReply({ content: 'Selection timed out.', components: [] });
      return;
    }
    await resolve(chosen);
  };

  await present(opts.items, opts.prompt);
}

/** Detail card + "Add to queue" button (used by /search). */
async function showDetail(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  item: MediaItem,
  queueInto: (id: string) => Promise<void>,
): Promise<void> {
  const provider = getProviderForGuild(guildId)!;
  const embed = new EmbedBuilder()
    .setTitle(displayTitle(item))
    .setColor(0x5865f2);
  const meta = [describe(item)].filter(Boolean).join('');
  if (meta) embed.addFields({ name: 'Details', value: meta });
  if (item.summary) embed.setDescription(item.summary.slice(0, 600));
  const thumb = provider.getThumbUrl(item.id);
  if (thumb) embed.setThumbnail(thumb);

  const button = new ButtonBuilder()
    .setCustomId('media_queue')
    .setLabel('Add to queue')
    .setEmoji('▶️')
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  const reply = (await interaction.editReply({ content: '', embeds: [embed], components: [row] })) as Message;

  const click = await awaitComponent<ButtonInteraction>(reply, ComponentType.Button);
  if (!click) {
    await interaction.editReply({ components: [] });
    return;
  }
  await click.deferUpdate();
  await queueInto(item.id);
}

/** Fetches metadata, queues the item into the given room, replies with links. */
export async function enqueueById(
  interaction: ChatInputCommandInteraction,
  room: Room,
  id: string,
): Promise<void> {
  const provider = getProviderForGuild(room.guildId)!;
  const item = await provider.getMetadata(id);
  if (!item) {
    await interaction.editReply({ content: 'Could not fetch metadata from the media server.', components: [], embeds: [] });
    return;
  }

  if (interaction.guild?.name) setGuildName(room.id, interaction.guild.name);
  const wasEmpty = room.queue.length === 0;
  addToQueue(room.id, item);

  const token = createSession(room.id);
  const watchUrl = `${config.server.publicUrl}/watch?token=${token}`;
  const title = displayTitle(item);

  const embed = new EmbedBuilder()
    .setTitle(wasEmpty ? `Now playing: ${title}` : `Queued: ${title}`)
    .setColor(wasEmpty ? 0xe5a00d : 0x5865f2)
    .setURL(watchUrl)
    .addFields(
      { name: 'Voice', value: `<#${room.voiceChannelId}>`, inline: true },
      { name: 'Watch page', value: `[Open](${watchUrl})`, inline: true },
    )
    .setFooter({ text: `Join the voice channel & open the link • session valid ${process.env.SESSION_TTL_MINUTES ?? 360} min` });
  const thumb = provider.getThumbUrl(item.id);
  if (thumb) embed.setThumbnail(thumb);

  await interaction.editReply({
    content: `🔊 Join <#${room.voiceChannelId}> • ▶ [Watch](${watchUrl})`,
    embeds: [embed],
    components: [],
  });
}

/**
 * Shared implementation for /play (autoQueue) and /search (preview-first).
 * Accepts either a free-text query or an `id:<ratingKey>` value chosen from
 * autocomplete, then hands off to the drill-down picker.
 */
export async function runSearchCommand(interaction: ChatInputCommandInteraction, autoQueue: boolean): Promise<void> {
  const guildId = interaction.guildId!;
  const provider = getProviderForGuild(guildId);
  if (!provider) {
    await interaction.reply({ content: 'No media server configured. An admin needs to run `/setup configure` first.', ephemeral: true });
    return;
  }

  const raw = interaction.options.getString('query', true);
  const label = raw.replace(/^id:/, '');
  await interaction.deferReply();

  let items: MediaItem[];
  if (raw.startsWith('id:')) {
    const it = await provider.getMetadata(raw.slice(3));
    items = it ? [it] : [];
  } else {
    items = await provider.search(raw, 75);
  }

  if (!items.length) {
    await interaction.editReply(`No results found for **${label}**.`);
    return;
  }
  await runPicker({
    interaction,
    guildId,
    items,
    prompt: `Results for **${label}**:`,
    autoQueue,
    resolveRoom: () => resolvePartyRoom(interaction),
  });
}

/** Autocomplete handler for title search options (used by /play and /search). */
export async function searchAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const provider = guildId ? getProviderForGuild(guildId) : null;
  const focused = interaction.options.getFocused();
  if (!provider || focused.trim().length < 2) {
    await safeRespond(interaction, []);
    return;
  }
  try {
    const results = await provider.search(focused, 25);
    await safeRespond(
      interaction,
      results.slice(0, 25).map(r => ({ name: displayTitle(r).slice(0, 100), value: `id:${r.id}`.slice(0, 100) })),
    );
  } catch {
    await safeRespond(interaction, []);
  }
}

async function safeRespond(interaction: AutocompleteInteraction, choices: { name: string; value: string }[]): Promise<void> {
  try {
    if (!interaction.responded) await interaction.respond(choices);
  } catch { /* interaction expired — ignore */ }
}

/** Waits for one component interaction on a message, or null on timeout. */
function awaitComponent<T>(message: Message, componentType: ComponentType): Promise<T | null> {
  return new Promise(resolveP => {
    const collector = message.createMessageComponentCollector({ componentType, time: PICK_TIMEOUT_MS, max: 1 } as never);
    let got: unknown = null;
    collector.on('collect', (i: unknown) => { got = i; });
    collector.on('end', () => resolveP(got as T | null));
  });
}
