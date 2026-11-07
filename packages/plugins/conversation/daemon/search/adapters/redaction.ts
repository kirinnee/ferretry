import type { Redaction } from '@ferretry/kernel/contract';
import type { ScrubText } from '../lib/documents.ts';
import type { WorkRedaction } from '../lib/service.ts';

/**
 * The work search's view of the kernel's read-scoped redaction. The scrub is valid for one batch only (the vault's
 * values are opened for that read and dropped after it, S20); nothing is cached here.
 *
 * `epoch` is how the index learns the set of known values changed. The kernel's `Redaction` carries no change
 * signal yet, so the epoch is whatever `bump` last set: the daemon wires it to the vault's change when the port
 * grows one. Until then a value registered after its text was indexed is still masked in every answer (the service
 * scrubs hits as they leave) but stays matchable until that piece of work next changes.
 */
export function workRedaction(redaction: Redaction): WorkRedaction & { bump(): void } {
  let epoch = 0;
  return {
    batch: async work =>
      await redaction.read(scope => work((text: string): string => scope.text(text)) as never as ReturnType<typeof work>),
    epoch: async () => String(epoch),
    bump: () => {
      epoch += 1;
    },
  };
}

export type { ScrubText };
