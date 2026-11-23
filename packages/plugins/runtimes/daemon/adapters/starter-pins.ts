/**
 * {@link StarterPins} over the plugin's own state (`RUNTIMES_PINS`): the model each (login, harness) launched with the first
 * time Ferretry saw it, one small file. Nothing is migrated: a login seen for the first time after this lands is pinned to
 * what it resolves to then, and a MISSING file is exactly that first run (an empty set). A file that exists and cannot be
 * read is never taken for an empty one: it is reported as unreadable, the caller refuses to launch derived runtimes, and the
 * file is never written over.
 */
import type { StatePort } from '@ferretry/kernel/contract';
import { RUNTIMES_PINS } from '../../contract/index.ts';
import { loginOfPinKey } from '../lib/account/derived-runtimes.ts';
import type { StarterPins } from './runtimes-config-files.ts';

export function statePins(state: Pick<StatePort, 'read' | 'update'>, warn: (sentence: string) => void): StarterPins {
  return {
    read: async () => {
      const read = await state.read(RUNTIMES_PINS);
      if (!read.ok) {
        warn(
          `the model pins of the derived runtimes could not be read (${read.error.reason}); they are refused until they can`,
        );
        return { state: 'unreadable', file: read.error.file };
      }
      return { state: 'read', pins: new Map(Object.entries(read.value?.models ?? {})) };
    },
    record: async (firstSeen, present) => {
      // Inside the file's own chain, so two reads that both saw a pair for the first time record ONE model for it (the
      // first writer's), and a login that is gone takes its pins with it: a later login of the same id starts fresh.
      const updated = await state.update(RUNTIMES_PINS, current => {
        const kept = Object.entries(current?.models ?? {}).filter(([key]) => {
          const login = loginOfPinKey(key);
          return login !== undefined && present.has(login);
        });
        const held = Object.fromEntries(kept);
        const fresh = [...firstSeen].filter(([key]) => held[key] === undefined);
        return { models: { ...held, ...Object.fromEntries(fresh) } };
      });
      if (!updated.ok) warn(`the model pins of the derived runtimes could not be recorded (${updated.error.reason})`);
    },
  };
}
