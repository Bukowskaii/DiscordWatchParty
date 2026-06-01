import { ChatInputCommandInteraction } from 'discord.js';
import { skipRoom, currentItem } from '../../rooms/manager';
import { broadcast } from '../../server/sync';
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

  const name = interaction.user.displayName ?? interaction.user.username;
  const next = currentItem(updated);
  if (!next) {
    broadcast(room.id, { type: 'stopped' });
    await interaction.reply('Queue finished.');
    return;
  }

  // Connected watch pages reload using their own token, so no link is needed here.
  broadcast(room.id, { type: 'media', ratingKey: next.id, title: next.title, durationMs: next.duration });

  const displayTitle = next.grandparentTitle
    ? `${next.grandparentTitle} S${next.parentIndex}E${next.index} – ${next.title}`
    : next.year ? `${next.title} (${next.year})` : next.title;

  broadcast(room.id, { type: 'notification', text: `${name} skipped to ${displayTitle}` });
  await interaction.reply(`Skipped. Now playing: **${displayTitle}**`);
}
