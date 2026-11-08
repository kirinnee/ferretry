/** A scripted Layouts client for the Layout tab's tests: what the daemon holds, every call in order, and a push. */
import { DaemonCallError } from '@ferretry/app';
import {
  COMPACT_LAYOUT,
  DEFAULT_LAYOUT,
  DEFAULT_THEME,
  type CurrentLayout,
  type LayoutList,
} from '../../contract/index.ts';
import type { LayoutsClient, LayoutsRead } from '../../app/lib/layouts-client.ts';

export const listOf = (overrides: Partial<LayoutList> = {}): LayoutList => ({
  layouts: [
    { id: 'default', origin: 'built-in' },
    { id: 'compact', origin: 'built-in' },
  ],
  themes: [{ id: 'default', origin: 'built-in' }],
  current: { layout: 'default', theme: 'default' },
  ...overrides,
});

export const readOf = (current: Partial<CurrentLayout> = {}, list: LayoutList = listOf()): LayoutsRead => ({
  current: { layout: DEFAULT_LAYOUT, theme: DEFAULT_THEME, ...current },
  list,
});

export const compactRead = (): LayoutsRead =>
  readOf({ layout: COMPACT_LAYOUT }, listOf({ current: { layout: 'compact', theme: 'default' } }));

/** The daemon's own refusal of a layout that names a view that is not installed. */
export const refusal = (message: string): DaemonCallError =>
  new DaemonCallError(422, 'layout_invalid', 'that layout cannot be used', {
    issues: [{ path: 'nav.items', message }],
  });

export interface ScriptedLayouts {
  readonly client: LayoutsClient;
  /** Every write, as the verb it is (`set nav.side right`, `use compact`, `reset`). */
  readonly calls: string[];
  readonly reads: () => number;
  /** What the next read answers. */
  held: LayoutsRead;
  /** Make the next write refuse with this. */
  refuseWith: Error | undefined;
  /** Tell every listener the layout changed (the CLI or another device wrote). */
  push(): void;
  readonly listeners: () => number;
}

export function scriptedLayouts(initial: LayoutsRead = readOf()): ScriptedLayouts {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let reads = 0;
  const script: ScriptedLayouts = {
    calls,
    reads: () => reads,
    held: initial,
    refuseWith: undefined,
    push: () => {
      for (const listener of listeners) listener();
    },
    listeners: () => listeners.size,
    client: {
      read: async () => {
        reads += 1;
        return script.held;
      },
      set: async (path, value) => write(`set ${path} ${value}`),
      switchLayout: async layout => write(`use ${layout}`),
      switchTheme: async theme => write(`theme ${theme}`),
      reset: async () => write('reset'),
      save: async id => write(`save ${id}`),
      remove: async id => write(`remove ${id}`),
      onChanged: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  async function write(call: string): Promise<void> {
    calls.push(call);
    if (script.refuseWith !== undefined) {
      const error = script.refuseWith;
      script.refuseWith = undefined;
      throw error;
    }
  }
  return script;
}
