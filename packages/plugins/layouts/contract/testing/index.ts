/** @ferretry/plugin-layouts/contract/testing — the fake and the conformance suite (§7.8). */
import { err, ok, type Result } from '@ferretry/std';
import {
  type CurrentLayout,
  CurrentLayoutSchema,
  DEFAULT_LAYOUT,
  DEFAULT_THEME,
  type LayoutList,
  LayoutListSchema,
  type LayoutsApi,
} from '../index.ts';

export { DEFAULT_LAYOUT, DEFAULT_THEME };

export function fakeLayouts(): LayoutsApi {
  const current: CurrentLayout = { layout: DEFAULT_LAYOUT, theme: DEFAULT_THEME };
  const list: LayoutList = {
    layouts: [{ id: 'default', origin: 'built-in' }],
    themes: [{ id: 'default', origin: 'built-in' }],
    current: { layout: 'default', theme: 'default' },
  };
  return { list: async () => list, current: async () => current };
}

/** What every implementation of `LayoutsApi` must satisfy. */
export async function layoutsConformance(make: () => LayoutsApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  if (!LayoutListSchema.safeParse(await api.list()).success) failures.push('list() returns a LayoutList');
  if (!CurrentLayoutSchema.safeParse(await api.current()).success) failures.push('current() returns a usable layout');
  return failures.length === 0 ? ok(true) : err(failures);
}
