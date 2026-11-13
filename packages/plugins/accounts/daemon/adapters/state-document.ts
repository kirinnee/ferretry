import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';

/**
 * ONE DECLARED STATE FILE, as a store adapter reads and writes it: the document's body (the kernel stamps and checks
 * `format`), `undefined` when there is no file yet, and a throw when it cannot be used. A damaged file is never read as
 * empty: the services above hold nothing for it, so every sign-in or paste asks.
 */
export interface StateDocument {
  read(): Promise<unknown>;
  write(body: unknown): Promise<void>;
  /** Copies the damaged file aside, never deleting it, before a fresh document replaces it. */
  setAside(suffix: string): Promise<void>;
}

/** The kernel's state port for one declared file. */
export function kernelStateDocument(state: StatePort, file: StateFileDef): StateDocument {
  return {
    async read() {
      const read = await state.read(file);
      if (!read.ok) throw new Error(read.error.sentence);
      return read.value;
    },
    async write(body) {
      await state.write(file, body);
    },
    async setAside() {
      // TODO(contract): the kernel's StatePort has no raw read or copy, so a damaged file cannot be kept beside a fresh
      // one (today's `<file>.damaged-<stamp>`). Refused, so a write never replaces the damaged file: the owner restores
      // it or resets the plugin (§9.3), and no approval is ever lost unseen.
      throw new Error('this build cannot copy the damaged file aside, so it is left as it is');
    },
  };
}
