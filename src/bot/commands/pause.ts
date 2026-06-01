import { ChatInputCommandInteraction } from 'discord.js';
import { pauseRoom } from '../../rooms/manager';
import { broadcast } from '../../server/sync';
import { findUserRoom } from '../party';
import { pauseData as data } from './definitions';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findUserRoom(interaction);
  if (!room) {
    await interaction.reply({ content: "You're not in a watch party. Join a party voice channel or start one with `/play`.", ephemeral: true });
    return;
  }
  const updated = pauseRoom(room.id);
  if (!updated) {
    await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    return;
  }
  broadcast(room.id, { type: 'pause', currentTimeMs: updated.currentTimeMs });
  await interaction.reply('Paused.');
}
