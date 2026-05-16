import { ChatInputCommandInteraction } from 'discord.js';
import { pauseRoom } from '../../rooms/manager';
import { getProviderForGuild } from '../../providers';
import { broadcast } from '../../server/sync';
import { pauseData as data } from './definitions';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!getProviderForGuild(interaction.guildId!)) {
    await interaction.reply({ content: 'No media server configured. Run `/setup configure` first.', ephemeral: true });
    return;
  }
  const room = pauseRoom(interaction.guildId!);
  if (!room) {
    await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    return;
  }
  broadcast(room.guildId, { type: 'pause', currentTimeMs: room.currentTimeMs });
  await interaction.reply('Paused.');
}
