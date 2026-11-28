/** The real kits of the two shipped harnesses, for a test that materialises runtimes (a missing kit leaves its harness's runtimes unavailable). */
import { claudeRuntimesKit } from '../../../claude-code/daemon/lib/runtimes-kit/index.ts';
import { codexRuntimesKit } from '../../../codex/daemon/lib/runtimes-kit/index.ts';
import { type ComponentSourceLookup, sourceHookFor } from '../../daemon/adapters/profile-components.ts';
import { supportedKinds } from '../../daemon/lib/harness-kind.ts';

export const REAL_KITS = new Map([
  ['claude', claudeRuntimesKit],
  ['codex', codexRuntimesKit],
] as const);

/** The catalog each real kit's sign-in reads, as the model catalog sources carry it. */
export const REAL_SIGN_IN: ReadonlyMap<'claude' | 'codex', string> = new Map(
  [...REAL_KITS].flatMap(([harness, kit]) =>
    kit.signInCatalog === undefined ? [] : [[harness, kit.signInCatalog] as const],
  ),
);

/** The owners of the two harnesses' settings, each giving its real kit and no component: what a daemon whose harness plugins are on hands Runtimes. */
export const KIT_OWNERS: ComponentSourceLookup = hook => {
  const kind = supportedKinds().find(candidate => sourceHookFor('settings', candidate) === hook);
  const kit = kind === undefined ? undefined : REAL_KITS.get(kind);
  return kit === undefined ? 'unavailable' : { list: async () => [], read: async () => undefined, kit };
};
