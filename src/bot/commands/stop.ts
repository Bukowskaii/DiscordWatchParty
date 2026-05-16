import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { stopRoom } from '../../rooms/manager';
import { getProviderForGuild } from '../../providers';
import { broadcast } from '../../server/sync';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback and clear the queue');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!getProviderForGuild(interaction.guildId!)) {
    await interaction.reply({ content: 'No media server configured. Run `/setup configure` first.', ephemeral: true });
    return;
  }
  const room = stopRoom(interaction.guildId!);
  if (!room) {
    await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    return;
  }
  broadcast(room.guildId, { type: 'stopped' });
  await interaction.reply('Stopped and queue cleared.');
}
