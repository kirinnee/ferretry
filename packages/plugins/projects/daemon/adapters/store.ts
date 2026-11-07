import type { StatePort } from '@ferretry/kernel/contract';
import { PROJECTS_STATE, type ProjectsFile } from '../../contract/index.ts';
import type { RegistryStore } from '../lib/ports.ts';

const DAMAGED = 'the project registry is damaged and cannot be read';
const EMPTY: ProjectsFile = { format: 1, projects: [] };

/** The registry file through the kernel's state port: atomic writes, one serialization chain, format checked. */
export function kernelStore(state: StatePort): RegistryStore {
  return {
    read: async () => {
      // Missing is the initial state. Damaged is evidence we cannot interpret.
      const read = await state.read(PROJECTS_STATE);
      if (!read.ok) throw new Error(DAMAGED);
      return read.value?.projects ?? [];
    },
    update: async change => {
      const done = await state.update(PROJECTS_STATE, current => change(current ?? EMPTY));
      if (!done.ok) throw new Error(DAMAGED);
    },
  };
}
