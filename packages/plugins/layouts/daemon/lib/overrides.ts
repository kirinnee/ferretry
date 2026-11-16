/**
 * `fy layout set <path> <value>` and the owner's overrides, as pure functions (§5.3). `config/layout.yaml` keeps the
 * keys changed from the layout in use; the current layout is that layout with them laid over. A layout that does not
 * come out valid is never served: the base, then the built-in default, stands in ("a layout cannot break the app").
 */
import {
  DEFAULT_LAYOUT,
  DEFAULT_THEME,
  type CurrentLayout,
  type Layout,
  type LayoutIssue,
  type LayoutOverrides,
  LayoutOverridesSchema,
  LayoutSchema,
  type LayoutSelection,
  type Theme,
} from '../../contract/index.ts';

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

/** Where a dotted path lands in the overrides object: `panels.ferret.side` is key `panels` › slot `ferret.side`. */
function keysOf(path: string): { readonly keys: readonly string[]; readonly list: boolean } | undefined {
  if (path.startsWith('panels.') && path.length > 'panels.'.length)
    return { keys: ['panels', path.slice('panels.'.length)], list: true };
  if (LIST_PATHS.has(path)) return { keys: path === 'composer.tools' ? [path] : path.split('.'), list: true };
  if (SCALAR_PATHS.has(path)) return { keys: path.split('.'), list: false };
  return undefined;
}

/** The paths `fy layout set` knows, for the sentence that refuses another. */
const SETTABLE_PATHS: readonly string[] = [...SCALAR_PATHS, ...LIST_PATHS, 'panels.<slot>'];

function listOf(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) return value.every(item => typeof item === 'string') ? (value as string[]) : undefined;
  if (typeof value !== 'string') return undefined;
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

export type SetResult =
  | { readonly ok: true; readonly overrides: LayoutOverrides }
  | { readonly ok: false; readonly issues: readonly LayoutIssue[] };

/** One change laid onto `overrides`; the answer is a new object, the input is untouched. */
function setOne(overrides: Record<string, unknown>, path: string, value: unknown): LayoutIssue | undefined {
  const place = keysOf(path);
  if (place === undefined)
    return { path, message: `"${path}" is not a layout setting (try ${SETTABLE_PATHS.join(', ')})` };
  const coerced = place.list ? listOf(value) : value;
  if (coerced === undefined || (!place.list && typeof coerced !== 'string'))
    return { path, message: place.list ? 'give a list of names, separated by commas' : 'give one word' };
  let cursor = overrides;
  for (const key of place.keys.slice(0, -1)) {
    const next = cursor[key];
    cursor[key] = typeof next === 'object' && next !== null && !Array.isArray(next) ? { ...next } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[place.keys[place.keys.length - 1] as string] = coerced;
  return undefined;
}

/**
 * Applies every change to the overrides in effect and checks the result: the overrides must parse, and laid over
 * `base` they must make a layout. Nothing is half-applied: any issue refuses the whole request.
 */
export function setPaths(
  base: Layout,
  current: LayoutOverrides,
  changes: readonly { readonly path: string; readonly value: unknown }[],
): SetResult {
  const draft = structuredClone(current) as Record<string, unknown>;
  const issues: LayoutIssue[] = [];
  for (const change of changes) {
    const issue = setOne(draft, change.path, change.value);
    if (issue !== undefined) issues.push(issue);
  }
  if (issues.length > 0) return { ok: false, issues };
  const parsed = LayoutOverridesSchema.safeParse(draft);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    };
  const laid = applyOverrides(base, parsed.data);
  if (!laid.ok) return laid;
  return { ok: true, overrides: parsed.data };
}

/** `base` with `overrides` laid over it, field by field; a layout that does not parse is refused with why. */
export function applyOverrides(
  base: Layout,
  overrides: LayoutOverrides,
): { readonly ok: true; readonly layout: Layout } | { readonly ok: false; readonly issues: readonly LayoutIssue[] } {
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
  return parsed.success
    ? { ok: true, layout: parsed.data }
    : {
        ok: false,
        issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
      };
}

/**
 * What the app draws: the selected layout with the owner's overrides. A selected layout that is gone, or overrides
 * that no longer fit it, never break anything: the layout without them, then the built-in default, stands in.
 */
export function resolveCurrent(
  selection: LayoutSelection,
  layouts: ReadonlyMap<string, Layout>,
  themes: ReadonlyMap<string, Theme>,
): CurrentLayout {
  const base = layouts.get(selection.layout) ?? DEFAULT_LAYOUT;
  const laid = applyOverrides(base, selection.overrides);
  return {
    layout: laid.ok ? laid.layout : base,
    theme: themes.get(selection.theme) ?? DEFAULT_THEME,
  };
}
