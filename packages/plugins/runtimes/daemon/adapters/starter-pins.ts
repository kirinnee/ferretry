/**
 * {@link StarterPins} over the plugin's own state (`RUNTIMES_PINS`): the model each derived runtime started with the first
 * time Ferretry saw it, by the runtime's stable name. One small file; nothing is migrated, so an existing runtime is pinned
 * to whatever it resolves to when it is first seen after this lands.
 */
import type { StatePort } from '@ferretry/kernel/contract';
import { RUNTIMES_PINS } from '../../contract/index.ts';
import type { StarterPins } from './runtimes-config-files.ts';

export function statePins(state: Pick<StatePort, 'read' | 'update'>, warn: (sentence: string) => void): StarterPins {
  return {
    read: async () => {
      const read = await state.read(RUNTIMES_PINS);
      if (!read.ok) {
        warn(
          `the first-seen models of the derived runtimes could not be read (${read.error.reason}); they follow the catalog default until they can`,
        );
        return undefined;
      }
      return new Map(Object.entries(read.value?.models ?? {}));
    },
    add: async models => {
      // Only a name with no pin yet is written, and inside the file's own chain, so two reads that both saw a runtime for the
      // first time record ONE model for it (the first writer's).
      const updated = await state.update(RUNTIMES_PINS, current => {
        const held = current?.models ?? {};
        const fresh = [...models].filter(([name]) => held[name] === undefined);
        return fresh.length === 0 ? (current ?? { models: {} }) : { models: { ...held, ...Object.fromEntries(fresh) } };
      });
      if (!updated.ok)
        warn(`the first-seen models of the derived runtimes could not be recorded (${updated.error.reason})`);
    },
  };
}
