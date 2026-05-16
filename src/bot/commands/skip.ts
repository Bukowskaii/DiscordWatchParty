import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { skipRoom, currentItem, createSession } from '../../rooms/manager';
import { getProviderForGuild } from '../../providers';
import { broadcast } from '../../server/sync';
import { config } from '../../config';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip to the next item in the queue');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!getProviderForGuild(interaction.guildId!)) {
    await interaction.reply({ content: 'No media server configured. Run `/setup configure` first.', ephemeral: true });
    return;
  }
  const room = skipRoom(interaction.guildId!);
  if (!room) {
    await interaction.reply({ content: 'Nothing in the queue.', ephemeral: true });
    return;
  }

  const next = currentItem(room);
  if (!next) {
    broadcast(room.guildId, { type: 'stopped' });
    await interaction.reply('Queue finished.');
    return;
  }

  const token = createSession(room.guildId);
  broadcast(room.guildId, {
    type: 'media',
    ratingKey: next.id,
    title: next.title,
    durationMs: next.duration,
    watchUrl: `${config.server.publicUrl}/watch?token=${token}`,
  });

  const displayTitle = next.grandparentTitle
    ? `${next.grandparentTitle} S${next.parentIndex}E${next.index} – ${next.title}`
    : next.year ? `${next.title} (${next.year})` : next.title;

  await interaction.reply(`Skipped. Now playing: **${displayTitle}**`);
}
