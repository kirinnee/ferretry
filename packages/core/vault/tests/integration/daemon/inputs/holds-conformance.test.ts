import type { RevealGrant, TargetRef } from '@ferretry/kernel/contract';
import { type HoldsSubject, inputHoldsConformance } from '../../../../contract/testing/index.ts';
import { InputHoldsOverService } from '../../../../daemon/adapters/inputs/holds.ts';
import { QuarantineRegistry } from '../../../../daemon/lib/inputs/quarantine.ts';
import { SESSION } from '../../../unit/daemon/inputs/support.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const keyOf = (target: TargetRef): string => `${target.kind}\u0000${target.key}`;

/**
 * The shipped holds over a stand-in for the input service: a target is put in each state the way the service would
 * report it, and the SAME conformance the fake passes is asked of the shipped adapter, so the two cannot drift.
 */
function shipped(): HoldsSubject {
  const pending = new Map<string, { readonly codeOnly: boolean }>();
  const pages = new Map<string, { readonly held: object; readonly document: string }>();
  const quarantine = new QuarantineRegistry({ now: () => NOW });
  const service = {
    openSessions: () => [SESSION],
    // A card of one-time codes does not keep a ferret off the target when it is only typing (I32).
    pendingOn: (_session: string, target: TargetRef, options?: { readonly typing?: boolean }) => {
      const card = pending.get(keyOf(target));
      return card === undefined || (card.codeOnly && options?.typing === true) ? undefined : 'card-1';
    },
    pageHeld: (_session: string, names: readonly string[]) =>
      names.map(name => pages.get(keyOf({ kind: 'page', key: name } as TargetRef))?.held).find(held => held),
    pageDocument: async (_session: string, name: string) =>
      pages.get(keyOf({ kind: 'page', key: name } as TargetRef))?.document,
  };
  return {
    holds: new InputHoldsOverService(service as never, quarantine, () => NOW),
    quarantine: target => quarantine.begin(SESSION, [target.key], 'host'),
    pageHold: (target, options) =>
      pages.set(keyOf(target), {
        held: {
          until: NOW + 120_000,
          documents: ['loader-1'],
          ...(options.untilMovedOn === true ? { documentsOnly: true as const } : {}),
        },
        document: options.onHeldDocument ? 'loader-1' : 'loader-2',
      }),
    pendingCard: (target, options) => pending.set(keyOf(target), { codeOnly: options.codeOnly }),
    reveal: target => ({ target, until: new Date(NOW + 60_000).toISOString() }) as unknown as RevealGrant,
  };
}

inputHoldsConformance('InputHoldsOverService', shipped);
