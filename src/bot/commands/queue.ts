import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getRoom, currentItem, getLiveTimeMs } from '../../rooms/manager';
import { queueData as data } from './definitions';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = getRoom(interaction.guildId!);
  if (!room || room.queue.length === 0) {
    await interaction.reply({ content: 'The queue is empty.', ephemeral: true });
    return;
  }

  const item = currentItem(room);
  const posMs = getLiveTimeMs(room);
  const posFmt = item ? formatMs(posMs) + ' / ' + formatMs(item.duration) : '—';

  const lines = room.queue.map((q, i) => {
    const prefix = i === room.currentIndex ? '▶ ' : `${i + 1}. `;
    const title = q.grandparentTitle
      ? `${q.grandparentTitle} S${q.parentIndex}E${q.index} – ${q.title}`
      : q.year ? `${q.title} (${q.year})` : q.title;
    return `${prefix}${title}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Queue')
    .setDescription(lines.join('\n'))
    .addFields({ name: 'Status', value: `${room.state} • ${posFmt}`, inline: true })
    .setColor(0x5865f2);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${pad(m % 60)}:${pad(s % 60)}`;
  return `${m}:${pad(s % 60)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
