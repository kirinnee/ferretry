import {
  DEFAULT_LAYOUT,
  type Layout,
  type LayoutOverrides,
  LayoutOverridesSchema,
  LayoutSchema,
} from '@ferretry/plugin-layouts/contract';
import { isSlotName, PANEL_SLOTS, SHELL_ITEMS } from './slots.ts';

/**
 * A LAYOUT IS DATA (§5.3): a YAML item (`layouts/<id>.yaml`, or `config/layout.yaml` written by `fy layout set`),
 * read by the Layouts plugin and handed to the shell as JSON (`GET /v1/layouts/current`). Its shape is the Layouts
 * contract's `LayoutSchema`, the one schema both ends parse. The shell checks a layout against the slot list and the
 * installed views and places plugin views by it. An unknown view name is refused, so a layout cannot break the app:
 * a refused layout leaves the next candidate (in the end the built-in default) in force and says why.
 *
 * The built-in default is the contract's `DEFAULT_LAYOUT` — the same layout the Layouts plugin ships as
 * `layouts/default.yaml` — and is what the shell uses with Layouts off.
 */

export { DEFAULT_LAYOUT, LayoutSchema };
export type { Layout, LayoutOverrides };

/** Which screen width the layout is resolved for. */
export type Viewport = 'phone' | 'wide';

/** A layout with its phone overrides applied: what the engine places. */
export interface ResolvedLayout {
  readonly id: string;
  readonly nav: Layout['nav'];
  readonly side: Layout['side'];
  readonly top: readonly string[];
  readonly panels: Readonly<Record<string, readonly string[]>>;
  readonly density: Layout['density'];
}

export function resolveLayout(layout: Layout, viewport: Viewport): ResolvedLayout {
  const panels: Record<string, readonly string[]> = { ...layout.panels };
  if (layout['composer.tools'] !== undefined) panels['composer.tools'] = layout['composer.tools'];
  const base: ResolvedLayout = {
    id: layout.id,
    nav: layout.nav,
    side: layout.side,
    top: layout.top,
    panels,
    density: layout.density,
  };
  if (viewport !== 'phone' || layout.phone === undefined) return base;
  const phone = layout.phone;
  return {
    ...base,
    nav: { ...base.nav, ...phone.nav },
    side: { ...base.side, ...phone.side },
    top: phone.top ?? base.top,
    density: phone.density ?? base.density,
  };
}

/** What a layout is checked against: the views the installed plugins declare (from their manifests). */
export interface InstalledViews {
  /** Screen ids (`board`) and qualified ids (`board.board`). */
  readonly screens: ReadonlySet<string>;
  /** Panel ids per slot. */
  readonly panels: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface LayoutIssue {
  readonly at: string;
  readonly message: string;
}

/**
 * `fy plugin check`'s layout rule, and the shell's own guard: every name must be a known slot, a shell item or an
 * installed view. A layout with any issue is refused WHOLE (no half-applied layout).
 */
export function checkLayout(layout: Layout, installed: InstalledViews): readonly LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const navItems: readonly string[] = SHELL_ITEMS.nav;
  const topItems: readonly string[] = SHELL_ITEMS.top;
  const checkNav = (at: string, items: readonly string[] | undefined): void => {
    for (const item of items ?? []) {
      if (!navItems.includes(item) && !installed.screens.has(item)) {
        issues.push({ at, message: `"${item}" is not an installed screen` });
      }
    }
  };
  checkNav('nav.items', layout.nav.items);
  checkNav('phone.nav.items', layout.phone?.nav?.items);
  for (const [at, items] of [
    ['top', layout.top],
    ['phone.top', layout.phone?.top],
  ] as const) {
    for (const item of items ?? []) {
      if (!topItems.includes(item)) issues.push({ at, message: `"${item}" is not a top-bar item` });
    }
  }
  for (const [at, side] of [
    ['side.holds', layout.side.holds],
    ['phone.side.holds', layout.phone?.side?.holds],
  ] as const) {
    if (side === undefined || side === 'none' || side === 'panels') continue;
    if (!installed.screens.has(side)) issues.push({ at, message: `"${side}" is not an installed screen` });
  }
  const panelSlots: readonly string[] = PANEL_SLOTS;
  const slots: [string, readonly string[]][] = Object.entries(layout.panels);
  if (layout['composer.tools'] !== undefined) slots.push(['composer.tools', layout['composer.tools']]);
  for (const [slot, ids] of slots) {
    if (!isSlotName(slot) || (!panelSlots.includes(slot) && !slot.includes('.') && slot !== 'side')) {
      issues.push({ at: `panels.${slot}`, message: `"${slot}" is not a slot that holds panels` });
      continue;
    }
    const known = installed.panels.get(slot) ?? new Set<string>();
    for (const id of ids) {
      if (!known.has(id)) issues.push({ at: `panels.${slot}`, message: `"${id}" is not a panel of ${slot}` });
    }
  }
  return issues;
}

export type LayoutChoice =
  | { readonly kind: 'applied'; readonly layout: Layout }
  | {
      readonly kind: 'refused';
      readonly layout: Layout;
      readonly refused: string;
      readonly issues: readonly LayoutIssue[];
    };

/**
 * Picks the layout in force: the device override first (`--device`, saved in this browser), then the daemon's, then
 * the built-in default. A candidate that does not parse or does not check is refused and the next one is tried.
 */
export function chooseLayout(candidates: readonly unknown[], installed: InstalledViews): LayoutChoice {
  let firstRefusal: { refused: string; issues: readonly LayoutIssue[] } | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const parsed = LayoutSchema.safeParse(candidate);
    const id = typeof (candidate as { id?: unknown }).id === 'string' ? (candidate as { id: string }).id : '?';
    if (!parsed.success) {
      firstRefusal ??= {
        refused: id,
        issues: parsed.error.issues.map(issue => ({ at: issue.path.join('.'), message: issue.message })),
      };
      continue;
    }
    const issues = checkLayout(parsed.data, installed);
    if (issues.length === 0) {
      return firstRefusal === undefined
        ? { kind: 'applied', layout: parsed.data }
        : { kind: 'refused', layout: parsed.data, ...firstRefusal };
    }
    firstRefusal ??= { refused: parsed.data.id, issues };
  }
  return firstRefusal === undefined
    ? { kind: 'applied', layout: DEFAULT_LAYOUT }
    : { kind: 'refused', layout: DEFAULT_LAYOUT, ...firstRefusal };
}

/**
 * One `fy layout set <path> <value>` edit, applied to a layout (the app's command bar runs the same edit for a
 * `--device` override). Supported paths are the ones §5.3 names: `nav.side`, `nav.style`, `nav.items`, `side.show`,
 * `side.holds`, `top`, `density`. Returns the edited layout or the reason it was refused.

// ─── this device's overrides (`--device`) ─────────────────────────────────────────────────────────────────────────
//
// The same overrides the owner's `config/layout.yaml` keeps (the contract's `LayoutOverridesSchema`, field by field),
// laid over a layout the same way the Layouts daemon half lays the owner's (`daemon/lib/overrides.ts`, copied): so a
// key this device did not change still follows the owner's layout.

/** Paths that take one word. */
const SCALAR_PATHS: ReadonlySet<string> = new Set([
  'nav.side',
  'nav.style',
  'side.show',
  'side.holds',
  'density',
  'phone.nav.side',
  'phone.nav.style',
  'phone.side.show',
  'phone.side.holds',
  'phone.density',
]);

/** Paths that take a list (`agenda,board`), besides `panels.<slot>`. */
const LIST_PATHS: ReadonlySet<string> = new Set(['nav.items', 'top', 'composer.tools', 'phone.nav.items', 'phone.top']);

function keysOf(path: string): { readonly keys: readonly string[]; readonly list: boolean } | undefined {
  if (path.startsWith('panels.') && path.length > 'panels.'.length)
    return { keys: ['panels', path.slice('panels.'.length)], list: true };
  if (LIST_PATHS.has(path)) return { keys: path === 'composer.tools' ? [path] : path.split('.'), list: true };
  if (SCALAR_PATHS.has(path)) return { keys: path.split('.'), list: false };
  return undefined;
}

const SETTABLE_PATHS: readonly string[] = [...SCALAR_PATHS, ...LIST_PATHS, 'panels.<slot>'];

function listOf(value: string): readonly string[] {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/** `base` with `overrides` laid over it, field by field; `undefined` when the result is not a layout. */
export function applyOverrides(base: Layout, overrides: LayoutOverrides): Layout | undefined {
  const phone =
    overrides.phone === undefined
      ? base.phone
      : {
          ...base.phone,
          ...overrides.phone,
          nav: { ...base.phone?.nav, ...overrides.phone.nav },
          side: { ...base.phone?.side, ...overrides.phone.side },
        };
  const merged = {
    ...base,
    ...(overrides.top === undefined ? {} : { top: overrides.top }),
    ...(overrides['composer.tools'] === undefined ? {} : { 'composer.tools': overrides['composer.tools'] }),
    ...(overrides.density === undefined ? {} : { density: overrides.density }),
    nav: { ...base.nav, ...overrides.nav },
    side: { ...base.side, ...overrides.side },
    panels: { ...base.panels, ...overrides.panels },
    ...(phone === undefined ? {} : { phone }),
  };
  const parsed = LayoutSchema.safeParse(merged);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One `layout set --device <path> <value>` edit (the app's command bar), laid onto this device's overrides and
 * checked against `base`, the owner's layout in force. Answers the new overrides or the reason it was refused.
 */
export function setDeviceOverride(
  base: Layout,
  overrides: LayoutOverrides,
  path: string,
  value: string,
): { readonly ok: true; readonly overrides: LayoutOverrides } | { readonly ok: false; readonly error: string } {
  const place = keysOf(path);
  if (place === undefined)
    return { ok: false, error: `"${path}" is not a layout setting (try ${SETTABLE_PATHS.join(', ')})` };
  const draft = structuredClone(overrides) as Record<string, unknown>;
  let cursor = draft;
  for (const key of place.keys.slice(0, -1)) {
    const next = cursor[key];
    cursor[key] = typeof next === 'object' && next !== null && !Array.isArray(next) ? { ...next } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[place.keys[place.keys.length - 1] as string] = place.list ? listOf(value) : value;
  const parsed = LayoutOverridesSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'not a valid layout' };
  if (applyOverrides(base, parsed.data) === undefined) return { ok: false, error: 'not a valid layout' };
  return { ok: true, overrides: parsed.data };
}

/** Stored overrides, or `undefined` when they do not parse (browser storage is a cache, never a source of truth). */
export function parseOverrides(raw: unknown): LayoutOverrides | undefined {
  const parsed = LayoutOverridesSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The candidates {@link chooseLayout} tries, in order (§5.3: a layout applies to the owner on every device by default,
 * `--device` for one): the owner's layout from the daemon with this device's overrides on top, then the owner's
 * layout alone (when the overrides are what a check refuses), then the built-in default with the overrides, and in
 * the end the built-in default itself.
 */
export function layoutCandidates(owner: Layout | undefined, overrides: LayoutOverrides): readonly Layout[] {
  const own = Object.keys(overrides).length > 0;
  const over = (layout: Layout): Layout[] => {
    const laid = own ? applyOverrides(layout, overrides) : undefined;
    return laid === undefined ? [] : [laid];
  };
  if (owner === undefined) return over(DEFAULT_LAYOUT);
  return [...over(owner), owner, ...over(DEFAULT_LAYOUT)];
}
