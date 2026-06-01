import { ChatInputCommandInteraction } from 'discord.js';
import { skipRoom, currentItem, createSession } from '../../rooms/manager';
import { broadcast } from '../../server/sync';
import { config } from '../../config';
import { findUserRoom } from '../party';
import { skipData as data } from './definitions';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findUserRoom(interaction);
  if (!room) {
    await interaction.reply({ content: "You're not in a watch party. Join a party voice channel or start one with `/play`.", ephemeral: true });
    return;
  }
  const updated = skipRoom(room.id);
  if (!updated) {
    await interaction.reply({ content: 'Nothing in the queue.', ephemeral: true });
    return;
  }

  const next = currentItem(updated);
  if (!next) {
    broadcast(room.id, { type: 'stopped' });
    await interaction.reply('Queue finished.');
    return;
  }

  const token = createSession(room.id);
  broadcast(room.id, {
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
