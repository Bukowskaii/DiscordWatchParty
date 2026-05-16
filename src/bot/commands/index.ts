import { Collection, ChatInputCommandInteraction } from 'discord.js';
import * as play from './play';
import * as queue from './queue';
import * as pause from './pause';
import * as resume from './resume';
import * as skip from './skip';
import * as stop from './stop';
import * as setup from './setup';

interface Command {
  data: { name: string; toJSON(): object };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

const list: Command[] = [setup, play, queue, pause, resume, skip, stop];

export const commands = new Collection<string, Command>();
for (const cmd of list) commands.set(cmd.data.name, cmd);

export const commandsJSON = list.map(cmd => cmd.data.toJSON());
