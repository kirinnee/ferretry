import type { Redaction } from '@ferretry/kernel/contract';
import type { ScrubText } from '../lib/documents.ts';
import type { WorkRedaction } from '../lib/service.ts';

/**
 * Names the set of secret values the redaction knows: a different answer means the set may have changed. Reading it
 * may fail, and then the search fails closed (it answers nothing rather than from an index built on older values).
 */
export type RedactionGeneration = () => string | Promise<string>;

/** The generation of a redaction that announces no change: the index is built once, and every answer re-judged. */
export const unchangingGeneration: RedactionGeneration = () => 'unchanging';

/**
 * The work search's view of the kernel's read-scoped redaction. The scrub is valid for one batch only (the vault's
 * values are opened for that read and dropped after it, S20); nothing is cached here.
 *
 * `epoch` is how the index learns the set of known values changed: it is the `generation` handed in, recorded at each
 * build, and a different one rebuilds the whole index before the next answer. The kernel's `Redaction` offers no
 * generation yet, so the daemon hands in {@link unchangingGeneration}; when the kernel's generation lands it is passed
 * here and nothing else changes. Either way the service re-judges every answer on its matched work scrubbed again in
 * one read, so a value registered after its text was indexed is neither shown nor matched.
 */
export function workRedaction(
  redaction: Redaction,
  generation: RedactionGeneration = unchangingGeneration,
): WorkRedaction {
  return {
    batch: async work =>
      await redaction.read(
        scope => work((text: string): string => scope.text(text)) as never as ReturnType<typeof work>,
      ),
    epoch: async () => await generation(),
  };
}

export type { ScrubText };
