/** @ferretry/plugin-layouts/contract/testing — the fake and the conformance suite (§7.8). */
import { err, ok, type Result } from '@ferretry/std';
import {
  type CurrentLayout,
  CurrentLayoutSchema,
  type LayoutList,
  LayoutListSchema,
  type LayoutsApi,
  LayoutSchema,
  ThemeSchema,
} from '../index.ts';

/** The built-in default (the same values as `layouts/default.yaml`), so a fake can answer without reading a file. */
export const DEFAULT_LAYOUT = LayoutSchema.parse({
  id: 'default',
  nav: { side: 'left', style: 'rail', items: ['agenda', 'ferrets', 'board', 'insights', 'settings'] },
  side: { show: 'wide-only', holds: 'ferret' },
  top: ['daemon-picker', 'search'],
  'composer.tools': ['mic', 'attach'],
  panels: { 'ferret.side': ['cards-of-ferret', 'sitrep', 'usage'] },
  density: 'comfortable',
  phone: { nav: { side: 'bottom', items: ['agenda', 'ferrets', 'board'] } },
});
export const DEFAULT_THEME = ThemeSchema.parse({ id: 'default', tokens: {} });

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
