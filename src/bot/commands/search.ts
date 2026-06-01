import { ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import { searchData as data } from './definitions';
import { runSearchCommand, searchAutocomplete } from './_media';

export { data };

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Preview-first: show a detail card with an "Add to queue" button instead of
  // queueing immediately.
  await runSearchCommand(interaction, false);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await searchAutocomplete(interaction);
}
