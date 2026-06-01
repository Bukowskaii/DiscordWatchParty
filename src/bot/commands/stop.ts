import { ChatInputCommandInteraction, ChannelType, VoiceBasedChannel } from 'discord.js';
import { broadcast } from '../../server/sync';
import { findUserRoom, teardownParty } from '../party';
import { stopData as data } from './definitions';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = await findUserRoom(interaction);
  if (!room) {
    await interaction.reply({ content: "You're not in a watch party.", ephemeral: true });
    return;
  }

  const channel = interaction.guild?.channels.cache.get(room.voiceChannelId);
  const voiceChannel = channel?.type === ChannelType.GuildVoice ? (channel as VoiceBasedChannel) : null;

  const name = interaction.user.displayName ?? interaction.user.username;
  broadcast(room.id, { type: 'notification', text: `${name} stopped the watch party` });
  await teardownParty(room.id, voiceChannel);
  await interaction.reply('Stopped the watch party and removed its voice channel.');
}
