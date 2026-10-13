/**
 * The Profiles tab and Build a profile, as data (docs/design/account-model.md §3.4, §4.5, E18, E19,
 * E21).
 *
 * A profile is an ordered list of layers, oldest first, and the newer layer wins. The daemon owns what
 * a stack resolves to — what applies per harness, what is skipped, what overrides what — and answers it
 * for saved profiles and, through the draft preview, for one being built. This module only reads those
 * answers and keeps the stepper's draft: which bases, which components, what name.
 *
 * Pure.
 */

import type {
  FleetAccountChange,
  FleetComponentKind,
  FleetLayerConflict,
  FleetLayeredProfileView,
  FleetRuntimeView,
  FleetStackView,
} from '@ferretry/protocol';
import { FleetComponentNameSchema } from '@ferretry/protocol';
import type { StepperFlowInput, StepperStep } from '../shell/stepper-model.ts';

export const PROFILE_PREFIX = 'profile/';

/** A layer as written: `profile/<name>` or `<kind>/<name>`. */
export type LayerRef =
  | { readonly kind: 'profile'; readonly name: string }
  | { readonly kind: 'component'; readonly componentKind: FleetComponentKind; readonly name: string };

const KINDS: ReadonlySet<string> = new Set(['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets']);

export function parseLayer(text: string): LayerRef | undefined {
  const slash = text.indexOf('/');
  if (slash <= 0) return undefined;
  const head = text.slice(0, slash);
  const name = text.slice(slash + 1);
  if (head === 'profile') return { kind: 'profile', name };
  return KINDS.has(head) ? { kind: 'component', componentKind: head as FleetComponentKind, name } : undefined;
}

/** Profiles whose stack includes this one, directly or through a base (never itself). */
export const includedBy = (profile: FleetLayeredProfileView): readonly string[] =>
  profile.wouldIncludeItself.filter(name => name !== profile.name);

export interface ProfileRuntimeUse {
  readonly runtime: string;
  /** The profile it reaches this one through, when it is not on this one itself. */
  readonly through?: string;
}

/** Every runtime this profile reaches: its own, and those on any profile built on it. */
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

/** How many components a profile flattens to ("6 parts"), whichever harness reads it. */
export function partCount(profile: FleetLayeredProfileView): number {
  const stack = profile.harnesses[0];
  return stack === undefined ? 0 : stack.applied.length + stack.skipped.length;
}

/** Every conflict across both harnesses, once each. */
export function stackConflicts(stacks: readonly FleetStackView[]): readonly FleetLayerConflict[] {
  const seen = new Set<string>();
  return stacks.flatMap(stack =>
    stack.conflicts.filter(conflict => {
      if (seen.has(conflict.sentence)) return false;
      seen.add(conflict.sentence);
      return true;
    }),
  );
}

// ── Build a profile ──────────────────────────────────────────────────────────────────────────────

export const BUILD_PROFILE_FLOW_KIND = 'build-profile';

/** The component kinds the stepper asks for, in order. Hooks are added from Edit layers or as components. */
export const BUILD_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'modelSets'] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

/** Every kind a draft keeps, in the order its layers are written (hooks included, so an edit keeps them). */
const DRAFT_KINDS: readonly FleetComponentKind[] = ['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets'];

export const BUILD_STEPS: readonly StepperStep[] = [
  { id: 'base', label: 'Start from' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'settings', label: 'Settings' },
  { id: 'modelSets', label: 'Model set' },
  { id: 'review', label: 'Review layers' },
  { id: 'name', label: 'Name' },
];

export interface BuildProfileOptions {
  /** The credential's harness, when opened from Add runtime. */
  readonly harness?: 'claude' | 'codex';
  /** The profile whose layers are being edited. */
  readonly editing?: string;
}

/** The stepper flow for Build a profile, or Edit layers when `editing` names a profile. */
export const buildProfileFlowInput = (options: BuildProfileOptions = {}): StepperFlowInput => ({
  kind: BUILD_PROFILE_FLOW_KIND,
  title: options.editing === undefined ? 'Build a profile' : `Edit ${options.editing}`,
  steps: BUILD_STEPS,
  leave: {
    question: 'Stop building this profile?',
    consequence: options.editing === undefined ? 'No profile is created.' : 'Your changes to the layers are not saved.',
    stopLabel: 'Stop, discard profile',
  },
});

export interface ProfileDraft {
  /** Base profiles, oldest first: a later one wins. */
  readonly bases: readonly string[];
  /** Component references picked per kind (`<kind>/<name>`). A model set is one at most. */
  readonly picks: Readonly<Record<FleetComponentKind, readonly string[]>>;
  readonly name: string;
}

const noPicks = (): Record<FleetComponentKind, readonly string[]> => ({
  instructions: [],
  mcp: [],
  skills: [],
  settings: [],
  hooks: [],
  modelSets: [],
});

export const emptyProfileDraft = (): ProfileDraft => ({ bases: [], picks: noPicks(), name: '' });

/** Edit layers starts from the profile as it is (the prototype's `start-build-edit`). */
export function draftFromProfile(profile: FleetLayeredProfileView): ProfileDraft {
  const picks = noPicks();
  const bases: string[] = [];
  for (const text of profile.layers) {
    const layer = parseLayer(text);
    if (layer === undefined) continue;
    if (layer.kind === 'profile') bases.push(layer.name);
    else picks[layer.componentKind] = [...picks[layer.componentKind], text];
  }
  return { bases, picks, name: profile.name };
}

/** The layers the draft saves, oldest first: bases, then components kind by kind. */
export const draftLayers = (draft: ProfileDraft): readonly string[] => [
  ...draft.bases.map(name => `${PROFILE_PREFIX}${name}`),
  ...DRAFT_KINDS.flatMap(kind => draft.picks[kind]),
];

export const toggleBase = (draft: ProfileDraft, name: string, on: boolean): ProfileDraft => ({
  ...draft,
  bases: on ? [...draft.bases.filter(base => base !== name), name] : draft.bases.filter(base => base !== name),
});

/** ↑ / ↓ in "Layer order · later wins". */
export function moveBase(draft: ProfileDraft, index: number, by: -1 | 1): ProfileDraft {
  const target = index + by;
  if (target < 0 || target >= draft.bases.length) return draft;
  const bases = [...draft.bases];
  [bases[index], bases[target]] = [bases[target] as string, bases[index] as string];
  return { ...draft, bases };
}

/** Ticks or unticks one component; a model set is a single choice, and `null` is "No model set". */
export function togglePick(draft: ProfileDraft, kind: FleetComponentKind, reference: string | null, on: boolean) {
  const current = draft.picks[kind];
  const next =
    kind === 'modelSets'
      ? reference === null || !on
        ? []
        : [reference]
      : on
        ? [...current.filter(item => item !== reference), reference as string]
        : current.filter(item => item !== reference);
  return { ...draft, picks: { ...draft.picks, [kind]: next } };
}

/** Why the name cannot be saved, or `undefined`. */
export function profileNameProblem(
  name: string,
  profiles: readonly FleetLayeredProfileView[],
  editing?: string,
): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'Give the profile a name.';
  if (!FleetComponentNameSchema.safeParse(trimmed).success) return 'Use a name without a slash or "..".';
  if (trimmed !== editing && profiles.some(profile => profile.name === trimmed))
    return `You already have a profile called ${trimmed}.`;
  return undefined;
}

/** The ONE change Save profile / Save changes asks for. */
export const profileChange = (draft: ProfileDraft, editing?: string): FleetAccountChange => ({
  kind: 'profile.put',
  name: editing ?? draft.name.trim(),
  layers: [...draftLayers(draft)],
  create: editing === undefined,
});
