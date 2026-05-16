import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from 'discord.js';
import { getProviderForGuild } from '../../providers';
import type { MediaItem } from '../../providers';
import { addToQueue, getOrCreateRoom, createSession, setGuildName } from '../../rooms/manager';
import { config } from '../../config';
import { playData as data } from './definitions';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const provider = getProviderForGuild(guildId);
  if (!provider) {
    await interaction.reply({ content: 'No media server configured. A server admin needs to run `/setup configure` first.', ephemeral: true });
    return;
  }

  const query = interaction.options.getString('query', true);
  await interaction.deferReply();

  const results = await provider.search(query);
  if (results.length === 0) {
    await interaction.editReply(`No results found for **${query}**.`);
    return;
  }

  if (results.length === 1) {
    await enqueue(interaction, guildId, results[0].id);
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('play_select')
    .setPlaceholder('Choose a result')
    .addOptions(
      results.map(r => ({
        label: displayTitle(r),
        value: r.id,
        description: r.type,
      })),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const reply = await interaction.editReply({
    content: `Found ${results.length} results for **${query}**:`,
    components: [row],
  });

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 30_000,
    max: 1,
  });

  collector.on('collect', async (sel: StringSelectMenuInteraction) => {
    await sel.deferUpdate();
    await enqueue(interaction, guildId, sel.values[0]);
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'time') {
      await interaction.editReply({ content: 'Selection timed out.', components: [] });
    }
  });
}

async function enqueue(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  id: string,
): Promise<void> {
  const provider = getProviderForGuild(guildId)!;
  const item = await provider.getMetadata(id);
  if (!item) {
    await interaction.editReply('Could not fetch metadata from the media server.');
    return;
  }

  const room = getOrCreateRoom(guildId);
  if (interaction.guild?.name) setGuildName(guildId, interaction.guild.name);
  const wasEmpty = room.queue.length === 0;
  addToQueue(guildId, item);

  const token = createSession(guildId);
  const watchUrl = `${config.server.publicUrl}/watch?token=${token}`;
  const title = displayTitle(item);

  const embed = new EmbedBuilder()
    .setTitle(wasEmpty ? `Now playing: ${title}` : `Queued: ${title}`)
    .setColor(wasEmpty ? 0xe5a00d : 0x5865f2)
    .setURL(watchUrl)
    .setFooter({ text: `Open the link to watch • session valid ${process.env.SESSION_TTL_MINUTES ?? 360} min` });

  await interaction.editReply({ content: `[Watch](${watchUrl})`, embeds: [embed], components: [] });
}

function displayTitle(item: MediaItem): string {
  if (item.grandparentTitle) {
    return `${item.grandparentTitle} S${item.parentIndex ?? '?'}E${item.index ?? '?'} – ${item.title}`;
  }
  return item.year ? `${item.title} (${item.year})` : item.title;
}
