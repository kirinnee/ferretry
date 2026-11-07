/**
 * Layouts' service: what the routes and the read model share. It reads `config/layout.yaml`, `config/layouts/` and
 * `config/themes/` through the plugin's `ConfigPort`, serves the built-ins beside the saved items, and writes through
 * the config door. Every write is one door call; nothing is kept in memory, so the files are the only truth.
 */
import type { ConfigCollectionDef, ConfigFileDef, ConfigPort } from '@ferretry/kernel/contract';
import {
  BUILT_IN_LAYOUTS,
  BUILT_IN_THEMES,
  DEFAULT_LAYOUT,
  type CurrentLayout,
  LAYOUT_CODES,
  type Layout,
  type LayoutId,
  type LayoutIssue,
  type LayoutList,
  type LayoutSelection,
  LayoutSelectionSchema,
  LAYOUTS_ITEMS as ITEMS_DEF,
  LAYOUTS_SELECTION as SELECTION_DEF,
  LAYOUTS_THEMES as THEMES_DEF,
  type Theme,
  type ThemeId,
  type ThemeList,
} from '../../contract/index.ts';
import type { ConfigDoor, DoorResult } from './config-door.ts';
import { applyOverrides, resolveCurrent, setPaths } from './overrides.ts';

/** Why a change did not happen. The route turns it into a status and a code. */
export type Refusal =
  | { readonly kind: 'invalid'; readonly code: typeof LAYOUT_CODES.invalid; readonly issues: readonly LayoutIssue[] }
  | { readonly kind: 'unknown'; readonly code: string; readonly sentence: string }
  | { readonly kind: 'conflict'; readonly code: string; readonly sentence: string }
  | { readonly kind: 'unavailable'; readonly code: typeof LAYOUT_CODES.noConfigDoor; readonly sentence: string };

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };
const done = <T>(value: T): Outcome<T> => ({ ok: true, value });
const refuse = (refusal: Refusal): Outcome<never> => ({ ok: false, refusal });

/** The contract widens its defs for the manifest; the service reads them back with their shapes. */
const LAYOUTS_SELECTION = SELECTION_DEF as ConfigFileDef<LayoutSelection>;
const LAYOUTS_ITEMS = ITEMS_DEF as ConfigCollectionDef<Layout>;
const LAYOUTS_THEMES = THEMES_DEF as ConfigCollectionDef<Theme>;

const NO_DOOR =
  'this daemon cannot change its configuration files from here, so the layout can be shown but not changed';

export interface LayoutsService {
  list(): LayoutList;
  themes(): ThemeList;
  current(): CurrentLayout;
  layout(id: LayoutId): Layout | undefined;
  set(changes: readonly { readonly path: string; readonly value: unknown }[]): Promise<Outcome<Layout>>;
  use(id: LayoutId): Promise<Outcome<Layout>>;
  useTheme(id: ThemeId): Promise<Outcome<Theme>>;
  reset(): Promise<Outcome<Layout>>;
  save(id: LayoutId): Promise<Outcome<{ readonly id: LayoutId; readonly origin: 'saved' }>>;
  remove(id: LayoutId): Promise<Outcome<LayoutId>>;
}

export function createLayoutsService(config: ConfigPort, door: ConfigDoor | undefined): LayoutsService {
  const selection = (): LayoutSelection => config.file(LAYOUTS_SELECTION) ?? LayoutSelectionSchema.parse({});

  /** Built-ins first: a saved item cannot shadow one. */
  const layouts = (): ReadonlyMap<string, Layout> => {
    const all = new Map<string, Layout>(config.collection(LAYOUTS_ITEMS));
    for (const layout of BUILT_IN_LAYOUTS) all.set(layout.id, layout);
    return all;
  };
  const themes = (): ReadonlyMap<string, Theme> => {
    const all = new Map<string, Theme>(config.collection(LAYOUTS_THEMES));
    for (const theme of BUILT_IN_THEMES) all.set(theme.id, theme);
    return all;
  };
  const builtIn = (id: string): boolean => BUILT_IN_LAYOUTS.some(layout => layout.id === id);
  const origin = (id: string): 'built-in' | 'saved' => (builtIn(id) ? 'built-in' : 'saved');

  const current = (): CurrentLayout => resolveCurrent(selection(), layouts(), themes());

  const written = async (result: Promise<DoorResult>): Promise<Refusal | undefined> => {
    const answer = await result;
    if (answer.kind === 'applied') return undefined;
    if (answer.kind === 'held')
      return { kind: 'conflict', code: 'config_held', sentence: `held for the owner: ${answer.sentences.join('; ')}` };
    return {
      kind: 'invalid',
      code: LAYOUT_CODES.invalid,
      issues: answer.issues.map(issue => ({ path: '', message: issue.message })),
    };
  };

  const unavailable: Refusal = { kind: 'unavailable', code: LAYOUT_CODES.noConfigDoor, sentence: NO_DOOR };

  return {
    list() {
      const now = selection();
      return {
        layouts: [...layouts().keys()].map(id => ({ id, origin: origin(id) })),
        themes: [...themes().keys()].map(id => ({
          id,
          origin: BUILT_IN_THEMES.some(t => t.id === id) ? 'built-in' : 'saved',
        })),
        current: { layout: now.layout, theme: now.theme },
      };
    },

    themes() {
      return {
        themes: [...themes().keys()].map(id => ({
          id,
          origin: BUILT_IN_THEMES.some(t => t.id === id) ? 'built-in' : 'saved',
        })),
        current: selection().theme,
      };
    },

    current,

    layout: id => layouts().get(id),

    async set(changes) {
      if (door === undefined) return refuse(unavailable);
      const now = selection();
      const base = layouts().get(now.layout) ?? DEFAULT_LAYOUT;
      const result = setPaths(base, now.overrides, changes);
      if (!result.ok) return refuse({ kind: 'invalid', code: LAYOUT_CODES.invalid, issues: result.issues });
      const refusal = await written(
        door.write(LAYOUTS_SELECTION, undefined, { patch: { overrides: result.overrides } }),
      );
      if (refusal !== undefined) return refuse(refusal);
      const laid = applyOverrides(base, result.overrides);
      return laid.ok ? done(laid.layout) : done(base);
    },

    async use(id) {
      const target = layouts().get(id);
      if (target === undefined)
        return refuse({ kind: 'unknown', code: LAYOUT_CODES.unknown, sentence: `there is no layout called ${id}` });
      if (door === undefined) return refuse(unavailable);
      // The old overrides were made against another layout; they start again with this one.
      const refusal = await written(
        door.write(LAYOUTS_SELECTION, undefined, { patch: { layout: id, overrides: undefined } }),
      );
      return refusal === undefined ? done(target) : refuse(refusal);
    },

    async useTheme(id) {
      const target = themes().get(id);
      if (target === undefined)
        return refuse({ kind: 'unknown', code: LAYOUT_CODES.themeUnknown, sentence: `there is no theme called ${id}` });
      if (door === undefined) return refuse(unavailable);
      const refusal = await written(door.write(LAYOUTS_SELECTION, undefined, { patch: { theme: id } }));
      return refusal === undefined ? done(target) : refuse(refusal);
    },

    async reset() {
      if (door === undefined) return refuse(unavailable);
      const refusal = await written(
        door.write(LAYOUTS_SELECTION, undefined, { patch: { layout: 'default', overrides: undefined } }),
      );
      return refusal === undefined ? done(DEFAULT_LAYOUT) : refuse(refusal);
    },

    async save(id) {
      if (layouts().has(id))
        return refuse({
          kind: 'conflict',
          code: LAYOUT_CODES.exists,
          sentence: `there is already a layout called ${id}`,
        });
      if (door === undefined) return refuse(unavailable);
      const saved: Layout = { ...current().layout, id };
      const refusal = await written(door.write(LAYOUTS_ITEMS, id, Bun.YAML.stringify(saved, null, 2)));
      return refusal === undefined ? done({ id, origin: 'saved' as const }) : refuse(refusal);
    },

    async remove(id) {
      if (builtIn(id))
        return refuse({
          kind: 'conflict',
          code: LAYOUT_CODES.builtIn,
          sentence: `${id} ships with Ferretry and cannot be removed`,
        });
      if (!layouts().has(id))
        return refuse({ kind: 'unknown', code: LAYOUT_CODES.unknown, sentence: `there is no layout called ${id}` });
      if (door === undefined) return refuse(unavailable);
      const refusal = await written(door.remove(LAYOUTS_ITEMS, id));
      return refusal === undefined ? done(id) : refuse(refusal);
    },
  };
}
