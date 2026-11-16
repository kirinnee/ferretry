import type { TargetKind } from '@ferretry/kernel/contract';
import type { HoldsChangedPayload } from '../../../contract/index.ts';
import type { InputClock } from '../../lib/inputs/ports.ts';
import { EVERY_TERMINAL, QuarantineRegistry } from '../../lib/inputs/quarantine.ts';
import type { HoldRegistry } from '../../lib/secrets/output-guard.ts';

/** Advance the final output check synchronously with each hold mutation, including restoration and expiry. */
export function quarantineOverOutputGuard(
  clock: InputClock,
  guard: HoldRegistry,
  publish: (event: HoldsChangedPayload) => void,
): QuarantineRegistry {
  return new QuarantineRegistry(clock, undefined, names => {
    for (const name of new Set(names)) {
      // The service marks page names to keep page "app" separate from terminal "app" in the shared registry.
      const targets =
        name === EVERY_TERMINAL
          ? [
              { kind: 'terminal' as TargetKind, key: '*' },
              { kind: 'page' as TargetKind, key: '*' },
            ]
          : [
              name.startsWith('~page:')
                ? { kind: 'page' as TargetKind, key: name.slice('~page:'.length) }
                : { kind: 'terminal' as TargetKind, key: name },
            ];
      for (const target of targets) publish({ target, generation: guard.moved(target) });
    }
  });
}
