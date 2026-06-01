import { ChatInputCommandInteraction } from 'discord.js';
import { resumeRoom } from '../../rooms/manager';
import { broadcast } from '../../server/sync';
import { findUserRoom } from '../party';
import { resumeData as data } from './definitions';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findUserRoom(interaction);
  if (!room) {
    await interaction.reply({ content: "You're not in a watch party. Join a party voice channel or start one with `/play`.", ephemeral: true });
    return;
  }
  const updated = resumeRoom(room.id);
  if (!updated) {
    await interaction.reply({ content: 'Nothing is paused.', ephemeral: true });
    return;
  }
  broadcast(room.id, { type: 'play', currentTimeMs: updated.currentTimeMs });
  await interaction.reply('Resumed.');
}
