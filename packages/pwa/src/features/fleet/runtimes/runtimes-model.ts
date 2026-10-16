/**
 * What the Runtimes tab and Add a runtime SAY — the pure half (docs/design/account-model.md §3.5, §4.4).
 *
 * The daemon resolves every runtime (its stack per harness, its model set, its fixed layer, whether it
 * can launch); this module only turns those answers into the words and choices on screen, so each one is
 * pinned by a test:
 *
 * - the name rule and its suggestion (R1, E16),
 * - which profiles fit a login's harness, and the note on the ones that only partly fit (P5, E14),
 * - "already uses this login and profile" (R4, E15),
 * - the model list with what this login cannot use struck through (K8, E23),
 * - the words on the Launch button (R5).
 */

import type {
  FleetComponentCatalog,
  FleetComponentView,
  FleetLayeredProfileView,
  FleetMachineView,
  FleetRuntimeView,
} from '@ferretry/protocol';
import { HARNESS_NAMES, SCOPE_WORDS } from '../components/component-model.ts';
import { HARNESS_SHORT, type HarnessKind, otherHarness, plural } from '../credentials/credentials-model.ts';

const NAME_PATTERN = /^[A-Za-z0-9-]+$/u;

/** The first free `<base>`, `<base>-2`, `<base>-3`, … */
export const uniqueName = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${String(index)}`)) index += 1;
  return `${base}-${String(index)}`;
};

/** Letters, digits and dashes only, lower case. */
export const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

export interface NameProblem {
  readonly message: string;
  /** A name that would work, offered as "Use <suggestion>". */
  readonly suggestion?: string;
}

/** Why a runtime name cannot be used, or `null` (R1, E16). */
export const runtimeNameProblem = (
  name: string,
  runtimes: readonly FleetRuntimeView[],
  machineName: string,
): NameProblem | null => {
  const taken = new Set(runtimes.map(runtime => runtime.name));
  if (name === '') return { message: 'Give the runtime a name.' };
  if (!NAME_PATTERN.test(name))
    return { message: 'Use only letters, digits and dashes.', suggestion: uniqueName(slug(name) || 'runtime', taken) };
  if (taken.has(name))
    return { message: `${name} is already a runtime on ${machineName}.`, suggestion: uniqueName(name, taken) };
  return null;
};

/** The prefilled name: harness plus profile, made unique (`claude-default`, `claude-default-2`). */
export const suggestedRuntimeName = (
  harness: HarnessKind,
  profile: string,
  runtimes: readonly FleetRuntimeView[],
): string => uniqueName(`${harness}-${slug(profile) || 'runtime'}`, new Set(runtimes.map(runtime => runtime.name)));

/** A runtime that already uses this login and profile (R4, E15). */
export const sameLoginAndProfile = (
  runtimes: readonly FleetRuntimeView[],
  credentialId: string,
  profile: string,
): FleetRuntimeView | undefined =>
  runtimes.find(runtime => runtime.credential.id === credentialId && runtime.profile === profile);

export type ProfileFit =
  | { readonly fits: true; readonly notes: readonly string[] }
  | { readonly fits: false; readonly reason: string };

/**
 * Whether a profile can be used with a login of this harness, and what to say about it (P5, P7, E14).
 * Its scope decides first: a Generic profile or one for this harness fits; one for the other harness
 * does not ("Codex only — this login is Claude Code"); a mixed one written before P7 does not either,
 * and says which layers disagree.
 */
export const profileFit = (profile: FleetLayeredProfileView, harness: HarnessKind): ProfileFit => {
  if (profile.scope.kind === 'mixed') return { fits: false, reason: profile.scope.sentence };
  if (profile.scope.scope !== 'generic' && profile.scope.scope !== harness)
    return { fits: false, reason: `${SCOPE_WORDS[profile.scope.scope]} — this login is ${HARNESS_NAMES[harness]}` };
  const stack = profile.harnesses.find(candidate => candidate.harness === harness);
  if (stack === undefined) return { fits: true, notes: [] };
  if (!stack.available.available) return { fits: false, reason: stack.available.reason };
  const notes: string[] = [];
  if (stack.skipped.length > 0)
    notes.push(`${HARNESS_SHORT[otherHarness(harness)]} settings will be skipped on ${HARNESS_NAMES[harness]}`);
  if (stack.partial.length > 0) notes.push(`Partly supported on ${HARNESS_NAMES[harness]}`);
  return { fits: true, notes };
};

/**
 * Add runtime's profile choices: every profile with its fit against the CLI it would run for this login
 * (`runsHarness`), the ones this login can use first, each group keeping the catalogue's order — so a
 * Codex-only profile sits below a Claude Code login's choices, disabled with its reason.
 */
export const profilesFitFirst = (
  profiles: readonly FleetLayeredProfileView[],
  harnesses: readonly HarnessKind[],
  chosen: HarnessKind | null = null,
): readonly { readonly profile: FleetLayeredProfileView; readonly fit: ProfileFit }[] => {
  const all = profiles.map(profile => ({ profile, fit: profileFit(profile, runsHarness(harnesses, chosen, profile)) }));
  return [...all.filter(entry => entry.fit.fits), ...all.filter(entry => !entry.fit.fits)];
};

/**
 * The CLI a profile runs for a login, for Add a runtime (docs/provider-presets.md). A login that drives
 * one CLI runs it. One that drives both runs the CLI the person chose under **Runs**; when they have not
 * chosen, the one the profile is scoped to, else the login's first — so a Codex-only profile fits a
 * Claude + Codex login by running Codex.
 */
export const runsHarness = (
  harnesses: readonly HarnessKind[],
  chosen: HarnessKind | null,
  profile?: FleetLayeredProfileView,
): HarnessKind => {
  const first = harnesses[0] ?? 'claude';
  if (harnesses.length < 2) return first;
  if (chosen !== null) return chosen;
  const scope = profile?.scope.kind === 'scoped' ? profile.scope.scope : 'generic';
  return scope === 'generic' ? first : scope;
};

/** "9 parts" for a profile row; its scope is the badge beside it. */
export const profileSummary = (profile: FleetLayeredProfileView, harness?: HarnessKind): string => {
  const stack = profile.harnesses.find(candidate => candidate.harness === harness) ?? profile.harnesses[0];
  return plural(stack === undefined ? 0 : stack.applied.length + stack.skipped.length, 'part');
};

/** Whether this runtime's harness is installed here (R5, E29). */
export const harnessInstalled = (machine: FleetMachineView | null, harness: HarnessKind): boolean =>
  machine === null || machine.tools.some(tool => tool.harness === harness && tool.installed);

/** The Launch button's words (R5): "Launch claude-default", or why it cannot. */
export const launchLabel = (runtime: FleetRuntimeView, machineName: string, online: boolean): string => {
  if (!online) return `Waiting for ${machineName}`;
  return runtime.launch.available ? `Launch ${runtime.name}` : runtime.launch.reason;
};

/** The row under a runtime's name: "you@example.com (work) · Default profile · Sonnet 5.5". */
export const runtimeDefaultModel = (runtime: FleetRuntimeView): string =>
  runtime.modelSet.source === 'model-set' ? (runtime.modelSet.default ?? 'No model available') : 'Harness default';

export interface ModelRow {
  readonly id: string;
  readonly available: boolean;
  readonly isDefault: boolean;
}

/** The model set as rows: struck-through models this login cannot use, and the default marked (E23). */
export const modelRows = (runtime: FleetRuntimeView): readonly ModelRow[] =>
  runtime.modelSet.source === 'model-set'
    ? runtime.modelSet.models.map(model => ({
        id: model.id,
        available: model.available,
        isDefault: runtime.modelSet.source === 'model-set' && model.id === runtime.modelSet.default,
      }))
    : [];

/** The sentence under the model list. */
export const modelSetNote = (runtime: FleetRuntimeView): string => {
  if (runtime.modelSet.source === 'harness-default')
    return 'No model set in this profile. The harness picks its own default.';
  const from = `From ${runtime.modelSet.name} in the ${runtime.profile} profile.`;
  if (runtime.modelSet.note !== undefined) return `${from} ${runtime.modelSet.note}`;
  if (runtime.modelSet.default === undefined)
    return `${from} None of its models are available on this login, so this runtime can't pick one.`;
  if (runtime.modelSet.default !== runtime.modelSet.declaredDefault)
    return `${from} Its default, ${runtime.modelSet.declaredDefault}, isn't available on this login, so this runtime starts on ${runtime.modelSet.default}, the first one that is.`;
  return from;
};

/** The six kinds as a layer row names them. Never the word "component". */
export const KIND_NAMES: Readonly<Record<FleetComponentView['kind'], string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

export interface LayerRow {
  /** As the profile names it: `<kind>/<name>` or `profile/<name>`. */
  readonly reference: string;
  /** "Instructions · Main instructions", "Profile · Default". */
  readonly title: string;
  /** "Used as a base", "Claude Code only", "Partly supported on Codex", a warning. */
  readonly notes: readonly string[];
  /** This harness skips it. */
  readonly skipped: boolean;
}

const componentFor = (catalog: FleetComponentCatalog | null, reference: string): FleetComponentView | undefined =>
  catalog?.kinds.flatMap(group => group.components).find(component => component.reference === reference);

/**
 * A profile's own layers, newest on top (§4.2), each with the notes a reader needs. A layer this
 * harness skips says so.
 */
export const layerRows = (
  profile: FleetLayeredProfileView,
  catalog: FleetComponentCatalog | null,
  harness: HarnessKind,
): readonly LayerRow[] => {
  const stack = profile.harnesses.find(candidate => candidate.harness === harness);
  const skipped = new Set(stack?.skipped.map(entry => entry.reference) ?? []);
  return [...profile.layers].reverse().map(reference => {
    const slash = reference.indexOf('/');
    const kind = reference.slice(0, slash);
    const name = reference.slice(slash + 1);
    if (kind === 'profile') return { reference, title: `Profile · ${name}`, notes: ['Used as a base'], skipped: false };
    const component = componentFor(catalog, reference);
    const notes: string[] = [];
    if (component?.harness !== undefined) notes.push(`${HARNESS_NAMES[component.harness]} only`);
    for (const partial of component?.partial ?? []) notes.push(`Partly supported on ${HARNESS_NAMES[partial.harness]}`);
    notes.push(...(component?.warnings ?? []));
    const title = `${KIND_NAMES[kind as FleetComponentView['kind']] ?? kind} · ${name}`;
    return { reference, title, notes, skipped: skipped.has(reference) };
  });
};

/** "2 layers · 9 parts · 1 skipped on Codex" for the profile row on a runtime's page. */
export const runtimeProfileLine = (runtime: FleetRuntimeView, profile: FleetLayeredProfileView | undefined): string => {
  const parts = runtime.stack.applied.length + runtime.stack.skipped.length;
  const layers = profile === undefined ? '' : `${plural(profile.layers.length, 'layer')} · `;
  const skipped =
    runtime.stack.skipped.length === 0
      ? ''
      : ` · ${String(runtime.stack.skipped.length)} skipped on ${HARNESS_NAMES[runtime.harness]}`;
  return `${layers}${plural(parts, 'part')}${skipped}`;
};
