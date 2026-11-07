import { type Layout, LayoutSchema, LayoutSelectionSchema } from '@ferretry/plugin-layouts/contract';
import type { z } from 'zod';
import { isSlotName, PANEL_SLOTS, SHELL_ITEMS } from './slots.ts';

/**
 * A LAYOUT IS DATA (§5.3): a YAML item (`layouts/<id>.yaml`, or `config/layout.yaml` written by `fy layout set`),
 * read by the Layouts plugin and handed to the shell as JSON (`GET /v1/layouts/current`). Its shape is the Layouts
 * contract's `LayoutSchema`, the one schema both ends parse; the shell checks a layout against the slot list and the
 * installed views, and places plugin views by it. An unknown view name is refused, so a layout cannot break the app:
 * a refused layout leaves the next candidate (in the end the built-in default) in force and says why.
 */

export { LayoutSchema };
export type { Layout };

/**
 * The shell's built-in layout (§5.3): what is in force with Layouts off, or when every other layout is refused. The
 * same layout the Layouts plugin ships as its `layouts/default.yaml` item.
 */
export const DEFAULT_LAYOUT: Layout = LayoutSchema.parse({
  id: 'default',
  nav: { side: 'left', style: 'rail', items: ['agenda', 'ferrets', 'board', 'insights', 'settings'] },
  side: { show: 'wide-only', holds: 'ferret' },
  top: ['daemon-picker', 'search'],
  'composer.tools': ['mic', 'attach'],
  panels: { 'ferret.side': ['cards-of-ferret', 'sitrep', 'usage'] },
  density: 'comfortable',
  phone: { nav: { side: 'bottom', items: ['agenda', 'ferrets', 'board'] } },
});

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
  // An empty `composer.tools` is the contract's default for "not listed": every declared tool shows, by order.
  if (layout['composer.tools'].length > 0) panels['composer.tools'] = layout['composer.tools'];
  const base: ResolvedLayout = {
    id: layout.id,
    nav: layout.nav,
    side: layout.side,
    top: layout.top,
    panels,
    density: layout.density,
  };
  if (viewport !== 'phone' || layout.phone === undefined) return base;
  return { ...base, nav: { ...base.nav, ...layout.phone.nav } };
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
  checkNav('phone.nav.items', layout.phone?.nav.items);
  for (const item of layout.top) {
    if (!topItems.includes(item)) issues.push({ at: 'top', message: `"${item}" is not a top-bar item` });
  }
  const holds = layout.side.holds;
  if (holds !== 'none' && holds !== 'panels' && !installed.screens.has(holds)) {
    issues.push({ at: 'side.holds', message: `"${holds}" is not an installed screen` });
  }
  const panelSlots: readonly string[] = PANEL_SLOTS;
  const slots: [string, readonly string[]][] = Object.entries(layout.panels);
  if (layout['composer.tools'].length > 0) slots.push(['composer.tools', layout['composer.tools']]);
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
 */
export function setLayoutField(
  layout: Layout,
  path: string,
  value: string,
): { readonly ok: true; readonly layout: Layout } | { readonly ok: false; readonly error: string } {
  const list = (text: string): string[] =>
    text
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0);
  const draft: Record<string, unknown> = structuredClone(layout) as unknown as Record<string, unknown>;
  const nav = draft.nav as Record<string, unknown>;
  const side = draft.side as Record<string, unknown>;
  switch (path) {
    case 'nav.side':
    case 'nav.style':
      nav[path.slice(4)] = value;
      break;
    case 'nav.items':
      nav.items = list(value);
      break;
    case 'side.show':
    case 'side.holds':
      side[path.slice(5)] = value;
      break;
    case 'top':
      draft.top = list(value);
      break;
    case 'density':
      draft.density = value;
      break;
    default:
      return { ok: false, error: `"${path}" is not a layout setting` };
  }
  const parsed = LayoutSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'not a valid layout' };
  return { ok: true, layout: parsed.data };
}

/**
 * A device's own layout changes (`--device`, §5.3): whole top-level keys of a layout, the same shape as the owner's
 * `overrides` in `config/layout.yaml` (the Layouts contract's `LayoutSelection.overrides`). They sit ON TOP of the
 * owner's layout, so a key this device did not change still follows the owner's.
 */
export const LayoutOverridesSchema = LayoutSelectionSchema.shape.overrides.unwrap();
export type LayoutOverrides = z.infer<typeof LayoutOverridesSchema>;

/**
 * Parses stored overrides, keeping ONLY the keys that were written. The contract's partial schema still fills the
 * defaults of `top`, `composer.tools` and `panels`, which as an override would wipe the owner's top bar; an override
 * names exactly what this device changed.
 */
export function parseOverrides(raw: unknown): LayoutOverrides | undefined {
  const parsed = LayoutOverridesSchema.safeParse(raw);
  if (!parsed.success || typeof raw !== 'object' || raw === null) return undefined;
  const written = new Set(Object.keys(raw));
  return Object.fromEntries(Object.entries(parsed.data).filter(([key]) => written.has(key))) as LayoutOverrides;
}

/** The layout with a device's overrides on top; an empty override set is the layout itself. */
export function applyOverrides(layout: Layout, overrides: LayoutOverrides): Layout {
  return Object.keys(overrides).length === 0 ? layout : { ...layout, ...overrides };
}

/** The top-level layout key a {@link setLayoutField} path edits. */
const KEY_OF_PATH: Readonly<Record<string, keyof LayoutOverrides>> = {
  'nav.side': 'nav',
  'nav.style': 'nav',
  'nav.items': 'nav',
  'side.show': 'side',
  'side.holds': 'side',
  top: 'top',
  density: 'density',
};

/**
 * `fy layout set --device <path> <value>`: the same edit as {@link setLayoutField}, made to the layout in force and
 * kept as this device's override of that one top-level key.
 */
export function setDeviceOverride(
  base: Layout,
  overrides: LayoutOverrides,
  path: string,
  value: string,
): { readonly ok: true; readonly overrides: LayoutOverrides } | { readonly ok: false; readonly error: string } {
  const key = KEY_OF_PATH[path];
  if (key === undefined) return { ok: false, error: `"${path}" is not a layout setting` };
  const edited = setLayoutField(applyOverrides(base, overrides), path, value);
  if (!edited.ok) return edited;
  return { ok: true, overrides: { ...overrides, [key]: edited.layout[key] } };
}

/**
 * The candidates {@link chooseLayout} tries, in order (§5.3: a layout applies to the owner on every device by default,
 * `--device` for one): the owner's layout from the daemon with this device's overrides on top, then the owner's
 * layout alone (when the overrides are what a check refuses), then the built-in default with the overrides, and in
 * the end the built-in default itself.
 */
export function layoutCandidates(owner: Layout | undefined, overrides: LayoutOverrides): readonly Layout[] {
  const own = Object.keys(overrides).length > 0;
  if (owner === undefined) return own ? [applyOverrides(DEFAULT_LAYOUT, overrides)] : [];
  return own ? [applyOverrides(owner, overrides), owner, applyOverrides(DEFAULT_LAYOUT, overrides)] : [owner];
}
