import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import { type SessionId, tryParseSessionId } from '../../seams/ferret-id.ts';
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

/**
 * Offers Ferrets a title made from a ferret's conversation (the production wiring of `adoptTitle`; the daemon runs this one function and the
 * kernel host test `conversation-titles-sweep` drives it). An id that is not a ferret's, or a Ferrets with no such port, keeps what it has.
 */
export function titleOffer(ferrets: {
  readonly adoptTitle?: ((ferret: SessionId, title: string) => Promise<'adopted' | 'kept'>) | undefined;
}): (ferret: string, title: string) => Promise<'adopted' | 'kept'> {
  return async (ferret, title) => {
    const id = tryParseSessionId(ferret);
    return id === undefined ? 'kept' : ((await ferrets.adoptTitle?.(id, title)) ?? 'kept');
  };
}

/** How often the daemon looks for a title a CLI has written since. */
const TITLE_SWEEP_MS = 5_000;

/**
 * Keeps ferrets' conversation titles fresh (the production wiring; `buildReading` starts it, and the kernel host test `conversation-titles-sweep` winds its clock): every
 * {@link TITLE_SWEEP_MS}, while some ferret's conversation can still take a title (its owner has not chosen one), the index is read
 * again, which offers that ferret any title its CLI wrote since. With every ferret titled by its owner nothing is read. Nothing
 * else asks the index in between (it is otherwise read only when a listing or a search needs it), so without this a title
 * Claude Code writes after the first exchange would reach the drawer only once somebody opened the Conversations list.
 * Returns what stops it. A tick still running when the next is due is not started twice.
 */
export function startTitleSweep(needs: {
  readonly every: (intervalMs: number, tick: () => void) => () => void;
  readonly names: () => Promise<FerretConversationNames>;
  readonly refresh: () => Promise<void>;
  readonly warn: (message: string) => void;
}): () => void {
  let running = false;
  return needs.every(TITLE_SWEEP_MS, () => {
    if (running) return;
    running = true;
    void (async () => {
      const names = await needs.names();
      if ([...names.values()].some(ferret => ferret.titleSource !== 'owner')) await needs.refresh();
    })()
      .catch((error: unknown) =>
        needs.warn(`The title sweep failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        running = false;
      });
  });
}
