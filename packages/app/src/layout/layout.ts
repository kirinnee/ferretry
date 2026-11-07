import { z } from 'zod';
import { isSlotName, PANEL_SLOTS, SHELL_ITEMS } from './slots.ts';

/**
 * A LAYOUT IS DATA (§5.3): a YAML item (`layouts/<id>.yaml`, or `config/layout.yaml` written by `fy layout set`),
 * read by the Layouts plugin and handed to the shell as JSON. The shell parses it here, checks it against the slot
 * list and the installed views, and places plugin views by it. An unknown view name is refused, so a layout cannot
 * break the app: a refused layout leaves the built-in default in force and says why.
 */

const ItemName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/u)
  .max(80);

const NavSchema = z.strictObject({
  side: z.enum(['left', 'right', 'top', 'bottom']),
  style: z.enum(['rail', 'bar', 'list']).default('rail'),
  items: z.array(ItemName).max(24),
});

const SideSchema = z.strictObject({
  show: z.enum(['never', 'wide-only', 'always']),
  /** `none`, a screen id, or `panels` (the `side` slot's panels). */
  holds: ItemName,
});

const PanelsSchema = z.record(z.string().max(80), z.array(ItemName).max(24));

const Density = z.enum(['compact', 'comfortable']);

/** What a narrow screen overrides. Every field optional; `nav` replaces field by field. */
const PhoneSchema = z.strictObject({
  nav: NavSchema.partial().optional(),
  side: SideSchema.partial().optional(),
  top: z.array(ItemName).max(8).optional(),
  density: Density.optional(),
});

export const LayoutSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/u)
    .max(40),
  nav: NavSchema,
  side: SideSchema.default({ show: 'never', holds: 'none' }),
  top: z.array(ItemName).max(8).default(['daemon-picker', 'search']),
  'composer.tools': z.array(ItemName).max(16).optional(),
  panels: PanelsSchema.default({}),
  density: Density.default('comfortable'),
  phone: PhoneSchema.optional(),
});

export type Layout = z.infer<typeof LayoutSchema>;
export type Density = z.infer<typeof Density>;

/**
 * The shell's built-in layout (§5.3): what is in force with Layouts off, or when a layout is refused. The Layouts
 * plugin ships the same default as its `layouts/default.yaml` item.
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
  readonly density: Density;
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
