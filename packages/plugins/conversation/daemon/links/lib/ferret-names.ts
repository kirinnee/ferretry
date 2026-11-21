import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { FerretConversationNames } from './conversation-index.ts';

/** The start placeholder a ferret with no task used to be named by: never a title, unless its owner typed it. */
const START_PLACEHOLDER = 'interactive';

/**
 * Which ferret runs each harness conversation (`"<harness>:<conversation id>"`), its name (the callsign: how it is found, never
 * how its conversation is called) and its task title with who chose it. A ferret with no title, or only the start placeholder
 * (which nobody chose), has none: its conversation is then named by the conversation itself.
 */
export function ferretConversationNames(
  summaries: readonly Pick<
    FerretSummary,
    'id' | 'harness' | 'harnessConversation' | 'name' | 'title' | 'titleSource'
  >[],
): FerretConversationNames {
  return new Map(
    summaries.flatMap(summary => {
      if (summary.harnessConversation === undefined) return [];
      const placeholder = summary.title?.trim().toLowerCase() === START_PLACEHOLDER && summary.titleSource !== 'owner';
      const titled = summary.title !== undefined && summary.title.trim() !== '' && !placeholder;
      return [
        [
          `${summary.harness}:${summary.harnessConversation}`,
          {
            ferret: summary.id,
            name: summary.name,
            // A title stored before the source existed is the owner's, as Ferrets reads it.
            ...(titled
              ? { title: summary.title as string, titleSource: summary.titleSource ?? ('owner' as const) }
              : {}),
          },
        ] as const,
      ];
    }),
  );
}
