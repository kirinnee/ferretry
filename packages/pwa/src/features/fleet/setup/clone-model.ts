/**
 * Clone from another machine, as data (docs/design/account-model.md §3.8, §4.7, E27–E31).
 *
 * **Source** → **Preview** → **Existing setup** (only when the target already has profiles or
 * runtimes) → **Done**. The browser holds both connections: it reads the source's export and hands it
 * to the target as the data of ONE reviewed change, `clone.import`. No machine talks to another.
 *
 * The preview is counted here from the export itself, so it says exactly what will travel: the
 * components, model sets, profiles and runtimes copy; an API-key login copies with its key (sealed, one
 * passkey) while each Claude Code or Codex SIGN-IN becomes an empty slot to sign in to on the target
 * (docs/secrets.md, owner decision 2026-10-20); history stays behind; a path under `/Users/` or `/home/` is flagged to check (E30); and a
 * runtime whose tool is missing on the target is copied and waits (E29). The daemon describes the
 * same copy again when it is staged, and that description is what the apply runs.
 *
 * WHAT RUNS IS LISTED, NOT COUNTED. MCP servers, hooks and settings start programs on the target, so
 * the preview lists every command, variable, runnable setting and document they bring — from
 * `cloneRunnables`, the one the target's own description reads — and each can be left out. A copy
 * from a machine that was broken into is how a command gets planted on the others.
 */

import {
  type CloneAgentRuntime,
  type CloneRunnable,
  cloneAgentRuntimes,
  cloneBundleProblem,
  cloneRunnables,
  type FleetCloneBundle,
  type FleetCredentialView,
  type FleetMachineView,
  suggestCloneDefault,
} from '@ferretry/protocol';
import type { MachineReach } from '../shell/machine-reach.ts';
import type { StepperStep } from '../shell/stepper-model.ts';
import { countWords, SETUP_HARNESSES, type SetupHarness } from './setup-words.ts';

export const CLONE_FLOW_KIND = 'clone';

export type CloneMode = 'alongside' | 'replace';

/** The steps: Existing setup only when the target has something to keep or replace (E28). */
export const cloneSteps = (targetHasSetup: boolean): StepperStep[] => [
  { id: 'source', label: 'Source' },
  { id: 'preview', label: 'Preview' },
  ...(targetHasSetup ? [{ id: 'existing', label: 'Existing setup' }] : []),
  { id: 'done', label: 'Done', final: true },
];

// ── Source ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What copying shows the source's reader: the copy goes both ways in trust, because the target sees
 * everything that is copied INTO it (docs/cross-daemon.md §3d).
 */
export const cloneSharesSentence = (target: string): string =>
  `${target} receives a copy of the instructions, skills, settings and hooks of the machine you pick, so only pick one whose setup you’re happy for ${target} to see. A sign-in never leaves it; an API key does only sealed, with your passkey.`;

export type CloneSourceState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly runtimeCount: number }
  /** Listed but not pickable, with the reason in words (E27). */
  | { readonly kind: 'disabled'; readonly reason: string };

/** Whether a paired machine can be copied from, from its one reachability read. */
export const cloneSourceState = (reach: MachineReach | undefined, name: string): CloneSourceState => {
  if (reach === undefined || reach.kind === 'checking') return { kind: 'checking' };
  if (reach.kind === 'offline')
    return { kind: 'disabled', reason: `${name} is asleep or offline. Wake it to copy from it.` };
  if (reach.kind === 'unreadable') return { kind: 'disabled', reason: reach.reason };
  if (!reach.machine.setUp) return { kind: 'disabled', reason: 'Not set up yet. Nothing to copy.' };
  return { kind: 'ready', runtimeCount: reach.machine.runtimeCount };
};

// ── Preview ──────────────────────────────────────────────────────────────────────────────────────

/** The same pattern the target flags with: a folder under somebody's home on the source. */
const HOME_PATH = /\/(?:Users|home)\/[^\s"'`,;)}\]]+/u;

export interface ClonePath {
  /** "Instructions · default". */
  readonly title: string;
  readonly path: string;
}

export interface ClonePreview {
  readonly components: number;
  readonly modelSets: number;
  readonly profiles: number;
  readonly runtimes: number;
  /** Every login in the bundle. */
  readonly logins: number;
  /** The sign-ins among them: each becomes an empty slot that needs sign-in on the target. */
  readonly signIns: number;
  /** The API-key (environment) logins: they copy, and their keys follow sealed. */
  readonly apiKeyLogins: number;
  readonly checkPaths: readonly ClonePath[];
  /** Tools the copied runtimes need that the target does not have (E29). */
  readonly missingTools: readonly SetupHarness[];
  /** Documents the source could not carry, with the reason. */
  readonly notCopied: readonly { readonly path: string; readonly reason: string }[];
  /** Every component that would run something on the target, chosen or not. */
  readonly runnables: readonly CloneRunnable[];
  /**
   * Why the target will refuse this bundle (`cloneBundleProblem`), or `null`. A refused bundle is never
   * offered for copying: its review could not be trusted to list everything it would write.
   */
  readonly problem: string | null;
  /** The components the person chose not to copy. */
  readonly skipped: number;
}

const KIND_TITLES: Readonly<Record<string, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The file a component names, when it names one. */
const componentFile = (component: unknown): string | undefined => {
  const file = recordOf(component).file;
  return typeof file === 'string' ? file : undefined;
};

/** Counts the bundle the source exported, against the target it would land on, without what is skipped. */
export const clonePreview = (
  bundle: FleetCloneBundle,
  target: FleetMachineView | null,
  skip: readonly string[] = [],
): ClonePreview => {
  let components = 0;
  let modelSets = 0;
  let skipped = 0;
  const checkPaths: ClonePath[] = [];
  const contents = new Map(bundle.files.map(file => [file.path, file.content]));
  for (const [kind, entries] of Object.entries(bundle.components)) {
    for (const [name, component] of Object.entries(entries)) {
      if (skip.includes(`${kind}/${name}`)) {
        skipped += 1;
        continue;
      }
      if (kind === 'modelSets') modelSets += 1;
      else components += 1;
      const file = componentFile(component);
      const text = `${JSON.stringify(component)}\n${file === undefined ? '' : (contents.get(file) ?? '')}`;
      const match = HOME_PATH.exec(text);
      if (match !== null) checkPaths.push({ title: `${KIND_TITLES[kind] ?? kind} · ${name}`, path: match[0] });
    }
  }
  const runtimes = Object.values(bundle.runtimes);
  const used = new Set(runtimes.map(runtime => recordOf(runtime).credential).filter(id => typeof id === 'string'));
  const neededTools = new Set(
    bundle.credentials.filter(credential => used.has(credential.id)).map(credential => credential.harness),
  );
  const installed = new Set(target?.tools.filter(tool => tool.installed).map(tool => tool.harness) ?? SETUP_HARNESSES);
  return {
    components,
    modelSets,
    profiles: Object.keys(bundle.profiles).length,
    runtimes: runtimes.length,
    logins: bundle.credentials.length,
    signIns: bundle.credentials.filter(credential => credential.store !== 'environment').length,
    apiKeyLogins: bundle.credentials.filter(credential => credential.store === 'environment').length,
    checkPaths,
    missingTools: SETUP_HARNESSES.filter(harness => neededTools.has(harness) && !installed.has(harness)),
    notCopied: bundle.notCopied,
    runnables: cloneRunnables(bundle),
    problem: cloneBundleProblem(bundle),
    skipped,
  };
};

/** "MCP server · notes": a runnable's title on the review. */
export const runnableTitle = (runnable: CloneRunnable): string => `${KIND_TITLES[runnable.kind]} · ${runnable.name}`;

/** "12 lines", for a document a runnable brings. */
export const documentSize = (text: string): string => countWords(text.replace(/\n$/u, '').split('\n').length, 'line');

/**
 * Where a copied item came from, as THIS reader would name it: their own label for the machine the
 * copying browser verified, when this browser knows it; otherwise the name the source gave itself,
 * said to be only that. `undefined` for an item that was not copied.
 */
export const cloneOriginName = (
  item: { readonly clonedFrom?: string; readonly clonedFromDaemon?: string },
  names: ReadonlyMap<string, string>,
): string | undefined => {
  const known = item.clonedFromDaemon === undefined ? undefined : names.get(item.clonedFromDaemon);
  if (known !== undefined) return known;
  return item.clonedFrom === undefined ? undefined : `${item.clonedFrom} (the name it gave itself)`;
};

/** "3 components" on the Copies list, and what each row covers. */
export const copiesRows = (preview: ClonePreview): readonly { readonly title: string; readonly detail?: string }[] => [
  {
    title: countWords(preview.components, 'component'),
    detail: 'Instructions, MCP servers, skills, settings and hooks',
  },
  { title: countWords(preview.modelSets, 'model set') },
  { title: countWords(preview.profiles, 'profile') },
  { title: countWords(preview.runtimes, 'runtime') },
];

// ── Existing setup ───────────────────────────────────────────────────────────────────────────────

/** "studio-mac already has 2 profiles and 3 runtimes." */
export const existingSentence = (machineName: string, profiles: number, runtimes: number): string =>
  `${machineName} already has ${countWords(profiles, 'profile')} and ${countWords(runtimes, 'runtime')}. What should happen to them?`;

// ── Default runtime for new agents ──────────────────────────────────────────────────────────────

/** The select value for "leave it unset". */
export const CLONE_NO_DEFAULT = '';
/** The select value for "keep what this machine has now"; a runtime name can never contain a colon. */
export const CLONE_KEEP_DEFAULT = 'keep:current';

export interface CloneDefaultView {
  /** The agent runtimes the copy brings, by the source's name. */
  readonly candidates: readonly CloneAgentRuntime[];
  /** Whether "keep the current default" is on offer: a plain copy leaves the target's runtimes standing. */
  readonly canKeep: boolean;
  /** The select's value: a runtime name, {@link CLONE_NO_DEFAULT} or {@link CLONE_KEEP_DEFAULT}. */
  readonly selected: string;
  /** What `clone.import` carries: a source runtime name, `null` to unset, or absent to let the target decide. */
  readonly send: string | null | undefined;
  /** What the choice means, in a sentence. */
  readonly sentence: string;
}

export interface CloneDefaultInput {
  readonly bundle: FleetCloneBundle;
  readonly mode: CloneMode;
  readonly machineName: string;
  /** The default the target has now, when it has one. */
  readonly targetDefault: string | undefined;
  /** The source's default, when "Agent controls and default runtime" is being copied along. */
  readonly sourceDefault: string | undefined;
  /** What the person picked: a source runtime name, `null` for none, or nothing yet. */
  readonly picked: string | null | undefined;
}

/**
 * "Default runtime for new agents" as the Preview offers it. Replace deletes the target's runtimes, so a
 * default that named one of them would dangle; the answer is always a concrete runtime the owner can see
 * and change, never a silent drop. In order: what the person picked; the source's own default when its
 * runtime is copied; the target's own default when a plain copy leaves it standing; otherwise the
 * runtime `suggestCloneDefault` proposes (the planner picks the same one), or none when the target had none.
 */
export function cloneDefaultView(input: CloneDefaultInput): CloneDefaultView {
  const { bundle, mode, machineName, targetDefault, sourceDefault, picked } = input;
  const candidates = cloneAgentRuntimes(bundle);
  const names = candidates.map(candidate => candidate.name);
  const canKeep = mode === 'alongside' && targetDefault !== undefined;
  const carried = sourceDefault !== undefined && names.includes(sourceDefault) ? sourceDefault : undefined;
  const proposed = suggestCloneDefault({ candidates });
  let selected: string;
  if (picked === null) selected = CLONE_NO_DEFAULT;
  else if (picked !== undefined && names.includes(picked)) selected = picked;
  else if (carried !== undefined) selected = carried;
  else if (canKeep) selected = CLONE_KEEP_DEFAULT;
  else if (targetDefault !== undefined && proposed !== undefined) selected = proposed;
  else selected = CLONE_NO_DEFAULT;

  const send =
    selected === CLONE_KEEP_DEFAULT
      ? undefined
      : selected === CLONE_NO_DEFAULT
        ? targetDefault === undefined
          ? undefined
          : null
        : selected;
  const gone = mode === 'replace' && targetDefault !== undefined;
  const sentence =
    selected === CLONE_KEEP_DEFAULT
      ? `${machineName} keeps its own default, ${targetDefault ?? ''}.`
      : selected === CLONE_NO_DEFAULT
        ? `No default is set on ${machineName}, so a session started with no runtime named uses the automatic one.`
        : gone
          ? `${machineName}’s default, ${targetDefault}, goes with the runtimes this copy replaces, so new agents start on ${selected}.`
          : `New agents on ${machineName} start on ${selected}.${mode === 'alongside' ? ' If this machine already uses that name, the copy is added as -2 and the default follows it.' : ''}`;
  return { candidates, canKeep, selected, send, sentence };
}

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

/** The empty slots this clone left on the target, the busiest first (E31). */
export const cloneSlots = (credentials: readonly FleetCredentialView[], source: string): FleetCredentialView[] =>
  credentials
    .filter(credential => credential.clonedFrom === source && credential.status.word === 'needs_sign_in')
    .toSorted((left, right) => right.usedBy.length - left.usedBy.length);
