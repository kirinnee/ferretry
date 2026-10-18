/**
 * Profiles as a bag of components (R5, docs/design/account-model.md §3.4), as data.
 *
 * A profile is a container: ONE ordered list of contents — components of any kind and other profiles —
 * where a later item overrides an earlier one wherever both set the same key. There are no fixed
 * slots and no stepper; order matters only for that override. This module keeps the editor's draft
 * (which items, in which order), the library it is filled from, and the words the editor shows.
 *
 * What a list RESOLVES to — which values win, what each overrode — is the daemon's answer (the draft
 * preview's `resolved`), never a second reading of the merge rules here. The one thing decided in
 * the browser is the refusal on drop: an item's own scope comes from the catalogue, and a profile
 * cannot hold Claude-only and Codex-only items together, so a drop that would mix them is refused
 * with the items to blame — before any request, so dragging stays instant. Saving is still checked
 * by the daemon.
 *
 * Pure.
 */

import {
  type FleetAccountChange,
  type FleetComponentKind,
  FleetComponentNameSchema,
  type FleetComponentView,
  type FleetHarnessScope,
  type FleetLayeredProfileView,
  type FleetProfileScope,
  type FleetResolvedEntry,
  type FleetRuntimeView,
} from '@ferretry/protocol';
import type { AccountCatalog } from '../components/account-catalog.ts';
import {
  type CatalogHarness,
  COMPONENT_KINDS,
  counted,
  HARNESS_NAMES,
  listed,
  SCOPE_WORDS,
} from '../components/component-model.ts';

export const PROFILE_PREFIX = 'profile/';

/** What one item in a profile is: a component of one kind, another profile, or text nothing reads. */
export type ItemKind = FleetComponentKind | 'profile' | 'unknown';

/** The kinds the library filters by, in the order its menu lists them. */
export const ITEM_KINDS: readonly Exclude<ItemKind, 'unknown'>[] = [...COMPONENT_KINDS, 'profile'];

/** The short word a row's kind tag shows. */
export const ITEM_KIND_WORDS: Readonly<Record<ItemKind, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Models',
  profile: 'Profile',
  unknown: 'Unknown',
};

/** One thing a profile can hold, as the library and the contents list draw it. */
export interface ProfileItem {
  /** As a profile's `contents` writes it: `<kind>/<name>` or `profile/<name>`. */
  readonly reference: string;
  readonly kind: ItemKind;
  readonly name: string;
  /** Generic, one tool's, or `mixed` for a profile written before scopes. */
  readonly scope: FleetHarnessScope | 'mixed';
}

const COMPONENT_KIND_SET: ReadonlySet<string> = new Set(COMPONENT_KINDS);

/** An item from its reference alone: a profile, a component of a known kind, or text as written. */
export function parseItem(reference: string): Pick<ProfileItem, 'kind' | 'name'> {
  const slash = reference.indexOf('/');
  const head = slash <= 0 ? '' : reference.slice(0, slash);
  if (head === 'profile') return { kind: 'profile', name: reference.slice(slash + 1) };
  if (COMPONENT_KIND_SET.has(head)) return { kind: head as FleetComponentKind, name: reference.slice(slash + 1) };
  return { kind: 'unknown', name: reference };
}

const profileItemScope = (scope: FleetProfileScope): ProfileItem['scope'] =>
  scope.kind === 'mixed' ? 'mixed' : scope.scope;

/**
 * The library: every component, then every profile but the one being edited, each with its scope
 * as the catalogue says it.
 */
export function libraryItems(catalog: AccountCatalog, editing?: string): readonly ProfileItem[] {
  const components = catalog.components.kinds.flatMap(group => group.components);
  return [
    ...components.map((component: FleetComponentView) => ({
      reference: component.reference,
      kind: component.kind,
      name: component.name,
      scope: component.scope,
    })),
    ...catalog.profiles.profiles
      .filter(profile => profile.name !== editing)
      .map(profile => ({
        reference: `${PROFILE_PREFIX}${profile.name}`,
        kind: 'profile' as const,
        name: profile.name,
        scope: profileItemScope(profile.scope),
      })),
  ];
}

/** The library narrowed by what was typed (name or kind) and by the kind menu. */
export function filterLibrary(
  items: readonly ProfileItem[],
  query: string,
  kind: ItemKind | 'all',
): readonly ProfileItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter(
    item =>
      (kind === 'all' || item.kind === kind) &&
      (needle === '' ||
        item.name.toLowerCase().includes(needle) ||
        ITEM_KIND_WORDS[item.kind].toLowerCase().includes(needle)),
  );
}

/** An item in the contents, looked up in the library; one it does not know is shown as written. */
export function itemFor(reference: string, library: readonly ProfileItem[]): ProfileItem {
  return library.find(item => item.reference === reference) ?? { reference, ...parseItem(reference), scope: 'generic' };
}

/** What the contents make the profile, and the items that make it so. */
export interface ContentScope {
  readonly scope: FleetHarnessScope | 'mixed';
  /** The items that narrow it to one tool (every narrowed item, for a mixed one). */
  readonly because: readonly ProfileItem[];
}

/** Scope is derived from the contents (R5): Generic until an item narrows it to one tool. */
export function contentScope(items: readonly ProfileItem[]): ContentScope {
  const claude = items.filter(item => item.scope === 'claude');
  const codex = items.filter(item => item.scope === 'codex');
  const mixed = items.filter(item => item.scope === 'mixed');
  if (mixed.length > 0 || (claude.length > 0 && codex.length > 0))
    return { scope: 'mixed', because: [...mixed, ...claude, ...codex] };
  if (claude.length > 0) return { scope: 'claude', because: claude };
  if (codex.length > 0) return { scope: 'codex', because: codex };
  return { scope: 'generic', because: [] };
}

export const scopeWord = (scope: ContentScope['scope']): string => (scope === 'mixed' ? 'Mixed' : SCOPE_WORDS[scope]);

const named = (items: readonly ProfileItem[]): string => listed(items.map(item => item.name));

/**
 * Why `item` cannot be added to the profile, or `undefined`. In order: it is already there, it is
 * the profile itself or would contain it, or it would mix Claude-only with Codex-only content — said
 * with the items to blame (R5).
 */
export function addRefusal(input: {
  readonly profile: string;
  readonly contents: readonly ProfileItem[];
  readonly item: ProfileItem;
  /** Profiles that include this one, so would make it include itself. */
  readonly loops: readonly string[];
  /** The login's tool, when the profile is being built for one (Add runtime). */
  readonly harness?: CatalogHarness;
}): string | undefined {
  const { profile, contents, item, loops, harness } = input;
  const label = profile === '' ? 'this profile' : profile;
  if (contents.some(each => each.reference === item.reference)) return `${item.name} is already in ${label}.`;
  if (item.kind === 'profile' && (item.name === profile || loops.includes(item.name)))
    return `${item.name} can’t go in ${label}: it already contains ${label}, so ${label} would contain itself.`;
  if (item.scope === 'mixed')
    return `Refused: ${item.name} mixes Claude-only and Codex-only content, so it can’t go in a profile.`;
  if (item.scope === 'generic') return undefined;
  const other = item.scope === 'claude' ? 'codex' : 'claude';
  if (harness !== undefined && item.scope !== harness)
    return `Refused: ${item.name} is ${SCOPE_WORDS[item.scope]}, but ${label} is for a ${HARNESS_NAMES[harness]} login.`;
  const culprits = contents.filter(each => each.scope === other || each.scope === 'mixed');
  if (culprits.length === 0) return undefined;
  return `Refused: ${item.name} is ${SCOPE_WORDS[item.scope]}, but ${label} is ${SCOPE_WORDS[other]} because of ${named(culprits)}. A profile can’t mix Claude-only and Codex-only content.`;
}

// ── Moving items ─────────────────────────────────────────────────────────────────────────────────

/** `reference` inserted before position `at` (clamped), never twice. */
export function insertAt(contents: readonly string[], reference: string, at: number): readonly string[] {
  const rest = contents.filter(each => each !== reference);
  const index = Math.max(0, Math.min(at, rest.length));
  return [...rest.slice(0, index), reference, ...rest.slice(index)];
}

/**
 * The item at `from` moved so it lands BEFORE the item that was at `before` (or last when `before`
 * is past the end) — exactly where a drop on a row puts it.
 */
export function moveBefore(contents: readonly string[], from: number, before: number): readonly string[] {
  const moving = contents[from];
  if (moving === undefined) return contents;
  const to = before > from ? before - 1 : before;
  return insertAt(
    contents.filter((_, index) => index !== from),
    moving,
    to,
  );
}

/** ↑ / ↓: one place earlier or later; at either end, nothing moves. */
export function moveBy(contents: readonly string[], index: number, by: -1 | 1): readonly string[] {
  const target = index + by;
  if (index < 0 || index >= contents.length || target < 0 || target >= contents.length) return contents;
  const next = [...contents];
  [next[index], next[target]] = [next[target] as string, next[index] as string];
  return next;
}

export const removeAt = (contents: readonly string[], index: number): readonly string[] =>
  contents.filter((_, at) => at !== index);

// ── What overrides what ──────────────────────────────────────────────────────────────────────────

/** One "overrides ‹X› · ‹key›" chip on a contents row. */
export interface OverrideChip {
  /** The earlier item's reference. */
  readonly over: string;
  readonly key: string;
}

/**
 * The chips each contents row carries, by reference: every key it sets that an EARLIER item in the
 * same list also set. Read from the daemon's resolved values, once per key and item across both
 * tools; an override inside one nested profile is that profile's own business and is not drawn.
 */
export function overrideChips(resolved: readonly FleetResolvedEntry[]): ReadonlyMap<string, readonly OverrideChip[]> {
  const chips = new Map<string, OverrideChip[]>();
  const seen = new Set<string>();
  for (const entry of resolved) {
    for (const beaten of entry.overridden) {
      if (beaten.from === entry.from) continue;
      const id = `${entry.from}\n${beaten.from}\n${entry.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      chips.set(entry.from, [...(chips.get(entry.from) ?? []), { over: beaten.from, key: entry.key }]);
    }
  }
  return chips;
}

/** The tools whose Resolved view is worth showing: the profile's own, or both for a Generic one. */
export function resolvedHarnesses(
  scope: ContentScope['scope'],
  resolved: readonly FleetResolvedEntry[],
): readonly CatalogHarness[] {
  if (scope === 'claude' || scope === 'codex') return [scope];
  const present = new Set(resolved.map(entry => entry.harness));
  const both: readonly CatalogHarness[] = ['claude', 'codex'];
  const shown = both.filter(harness => present.has(harness));
  return shown.length === 0 ? ['claude'] : shown;
}

/** The words a Resolved row's key column shows: "MCP · github", "env.MODE", "model". */
export const RESOLVED_FIELD_WORDS: Readonly<Record<FleetResolvedEntry['field'], string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skill',
  settings: 'Setting',
  env: 'Environment',
  flags: 'Flag',
  hooks: 'Hooks',
  model: 'Model',
};

/** The name a reference is shown by: the component's or profile's own name. */
export const itemName = (reference: string): string => parseItem(reference).name;

// ── Saving ───────────────────────────────────────────────────────────────────────────────────────

/** Why the name cannot be saved, or `undefined`. */
export function profileNameProblem(name: string, profiles: readonly FleetLayeredProfileView[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'Give the profile a name.';
  if (!FleetComponentNameSchema.safeParse(trimmed).success) return 'Use a name without a slash or "..".';
  if (profiles.some(profile => profile.name === trimmed)) return `You already have a profile called ${trimmed}.`;
  return undefined;
}

/** The ONE change Save asks for: the whole contents list, in order. */
export const profileChange = (name: string, contents: readonly string[], create: boolean): FleetAccountChange => ({
  kind: 'profile.put',
  name: name.trim(),
  layers: [...contents],
  create,
});

/** Whether two contents lists are the same items in the same order. */
export const sameContents = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((reference, index) => right[index] === reference);

// ── Where a profile is used ──────────────────────────────────────────────────────────────────────

/** Profiles whose contents include this one, directly or through another (never itself). */
export const includedBy = (profile: FleetLayeredProfileView): readonly string[] =>
  profile.wouldIncludeItself.filter(name => name !== profile.name);

export interface ProfileRuntimeUse {
  readonly runtime: string;
  /** The profile it reaches this one through, when it is not on this one itself. */
  readonly through?: string;
}

/** Every runtime this profile reaches: its own, and those on any profile that contains it. */
export function runtimesReaching(
  profile: FleetLayeredProfileView,
  runtimes: readonly FleetRuntimeView[],
): readonly ProfileRuntimeUse[] {
  const reaching = new Set([profile.name, ...includedBy(profile)]);
  return runtimes
    .filter(runtime => reaching.has(runtime.profile))
    .map(runtime =>
      runtime.profile === profile.name
        ? { runtime: runtime.name }
        : { runtime: runtime.name, through: runtime.profile },
    );
}

/** How many components a profile flattens to ("6 parts"), whichever tool reads it. */
export function partCount(profile: FleetLayeredProfileView): number {
  const stack = profile.harnesses[0];
  return stack === undefined ? 0 : stack.applied.length + stack.skipped.length;
}

/** The one line under a profile's name on the list: "3 items · 6 parts · used by 2 runtimes". */
export const profileUseLine = (profile: FleetLayeredProfileView, runtimes: number): string =>
  `${counted(profile.layers.length, 'item')} · ${counted(partCount(profile), 'part')} · ${runtimes === 0 ? 'not used yet' : `used by ${counted(runtimes, 'runtime')}`}`;
