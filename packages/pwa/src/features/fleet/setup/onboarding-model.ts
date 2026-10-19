/**
 * New machine setup, as data (spec R4, R6; build plan P9).
 *
 * Ten steps on ONE PROGRESS RAIL, not a forced stepper and never a stepper inside a step: **Pair** →
 * **Start from** → **Claude Code** → **Codex** → **Speed-ups** → **Voice** → **Warden** → **Learning** →
 * **Agent controls** → **Done**. Every step can be skipped, any step can be opened from the rail at any
 * time, and every one of them is also a panel in Settings, so a skipped step is never lost — Done lists
 * it with a "Set up later" link to that panel. The Claude Code and Codex steps each make their runtime in
 * place (`harness-import-model.ts`): there is no separate runtime wizard.
 *
 * NOTHING HERE IS SENT ANYWHERE. A step saves through its own surface (Speed-ups through the secret
 * route, the Warden through its PATCH, a control through a reviewed change); this module only knows
 * where the person is, which steps they finished or skipped, and how to say so. The progress is kept
 * in THIS browser (`setup-progress.ts`) — step ids and two words, never a value from the machine.
 *
 * Pure: the progress in, the next progress and the words out.
 */

import type { WardenConfig } from '@ferretry/protocol';
import type { HarnessAnswers } from './harness-import-model.ts';
import type { SetupHarness } from './setup-words.ts';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { daemonSettingsPath } from '../../../lib/pages/routes.ts';
import { type MachineTabId, machineHash } from '../shell/machine-route.ts';
import { machineItemHash } from './settings-route.ts';

/** The steps, in the order the rail lists them. The ids are what progress stores. */
export const ONBOARDING_STEPS = [
  { id: 'pair', label: 'Pair this device' },
  { id: 'start', label: 'Start from…' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'speedups', label: 'Speed-ups' },
  { id: 'voice', label: 'Voice' },
  { id: 'warden', label: 'Warden' },
  { id: 'learning', label: 'Learning' },
  { id: 'controls', label: 'Agent controls' },
  { id: 'done', label: 'Done' },
] as const;

export type MachineSetupStepId = (typeof ONBOARDING_STEPS)[number]['id'];

/** Every step but Done: the ones that can be set or skipped. */
export type MachineSetupTaskId = Exclude<MachineSetupStepId, 'done'>;

export const ONBOARDING_TASKS: readonly MachineSetupTaskId[] = ONBOARDING_STEPS.filter(
  (step): step is (typeof ONBOARDING_STEPS)[number] & { readonly id: MachineSetupTaskId } => step.id !== 'done',
).map(step => step.id);

const STEP_IDS: ReadonlySet<string> = new Set(ONBOARDING_STEPS.map(step => step.id));

export const isMachineSetupStepId = (value: string): value is MachineSetupStepId => STEP_IDS.has(value);

/** What the person did with a step. A step they never reached has no state. */
export type MachineSetupStepState = 'done' | 'skipped';

/** Where the setup starts from: walk through each step, or copy another machine's settings first. */
export type MachineSetupStart = 'fresh' | 'clone';

export interface MachineSetupProgress {
  readonly at: MachineSetupStepId;
  readonly states: Readonly<Partial<Record<MachineSetupTaskId, MachineSetupStepState>>>;
  readonly start: MachineSetupStart;
  /** What was answered on the Claude Code and Codex steps — the runtime name typed — so Finish later keeps it. */
  readonly answers?: Readonly<Partial<Record<SetupHarness, HarnessAnswers>>>;
}

/**
 * Where a new setup begins. Pairing is already done — this screen is only reachable through a pairing,
 * and pairing can never be relayed, so the device on it has already met the machine directly — so the
 * rail shows it set and the person starts on the first real choice.
 */
export const ONBOARDING_START: MachineSetupProgress = { at: 'start', states: { pair: 'done' }, start: 'fresh' };

export const onboardingStepLabel = (id: MachineSetupStepId): string =>
  (ONBOARDING_STEPS.find(step => step.id === id) as (typeof ONBOARDING_STEPS)[number]).label;

const indexOf = (id: MachineSetupStepId): number => ONBOARDING_STEPS.findIndex(step => step.id === id);

const after = (id: MachineSetupStepId): MachineSetupStepId =>
  (ONBOARDING_STEPS[Math.min(indexOf(id) + 1, ONBOARDING_STEPS.length - 1)] as (typeof ONBOARDING_STEPS)[number]).id;

const before = (id: MachineSetupStepId): MachineSetupStepId =>
  (ONBOARDING_STEPS[Math.max(indexOf(id) - 1, 0)] as (typeof ONBOARDING_STEPS)[number]).id;

const isTask = (id: MachineSetupStepId): id is MachineSetupTaskId => id !== 'done';

/** Open any step from the rail. Nothing is marked: looking is not doing. */
export const goToOnboardingStep = (progress: MachineSetupProgress, id: MachineSetupStepId): MachineSetupProgress => ({
  ...progress,
  at: id,
});

/**
 * The steps that are set only by their own button: a CLI's step is set once its import made the runtime,
 * so Continue past one that was not imported says "skipped" rather than claiming a runtime exists.
 */
const SET_BY_THEIR_OWN_BUTTON: ReadonlySet<MachineSetupStepId> = new Set(['claude', 'codex']);

/** Continue: this step is set, and the next one opens. A CLI step not imported yet counts as skipped. */
export const continueOnboarding = (progress: MachineSetupProgress): MachineSetupProgress =>
  SET_BY_THEIR_OWN_BUTTON.has(progress.at)
    ? skipOnboardingStep(progress)
    : {
        ...progress,
        at: after(progress.at),
        states: isTask(progress.at) ? { ...progress.states, [progress.at]: 'done' } : progress.states,
      };

/** Keep what was answered on a CLI's step. */
export const answerOnboardingHarness = (
  progress: MachineSetupProgress,
  harness: SetupHarness,
  answers: HarnessAnswers,
): MachineSetupProgress => ({ ...progress, answers: { ...progress.answers, [harness]: answers } });

/**
 * Skip: the next one opens, and this one is marked skipped — unless it was already set, because skipping
 * past a step you finished earlier (coming back through the rail) must not unset it.
 */
export const skipOnboardingStep = (progress: MachineSetupProgress): MachineSetupProgress => {
  const at = progress.at;
  const keep = !isTask(at) || progress.states[at] === 'done';
  return {
    ...progress,
    at: after(at),
    states: keep ? progress.states : { ...progress.states, [at]: 'skipped' },
  };
};

/** Back one step. Nothing is marked. */
export const backOnboardingStep = (progress: MachineSetupProgress): MachineSetupProgress => ({
  ...progress,
  at: before(progress.at),
});

/** Mark a step set without moving: a surface that saved on its own (a key stored, a clone copied). */
export const markOnboardingStep = (progress: MachineSetupProgress, id: MachineSetupTaskId): MachineSetupProgress => ({
  ...progress,
  states: { ...progress.states, [id]: 'done' },
});

export const chooseOnboardingStart = (
  progress: MachineSetupProgress,
  start: MachineSetupStart,
): MachineSetupProgress => ({
  ...progress,
  start,
});

/** "3 of 8 set": the rail's heading. */
export const onboardingSetCount = (progress: MachineSetupProgress): string =>
  `${String(ONBOARDING_TASKS.filter(id => progress.states[id] === 'done').length)} of ${String(ONBOARDING_TASKS.length)} set`;

/** The rail's marker for one step: its number, ✓ when set, – when skipped. */
export const onboardingRailMarker = (progress: MachineSetupProgress, id: MachineSetupStepId): string => {
  const state = isTask(id) ? progress.states[id] : undefined;
  if (state === 'done') return '✓';
  if (state === 'skipped') return '–';
  return String(indexOf(id) + 1);
};

// ── Set up later ─────────────────────────────────────────────────────────────────────────────────

/**
 * Where each step lives in Settings once setup is over: a Machine-tab panel, a machine tab, or — for
 * Voice, whose engine belongs to this DEVICE — Settings › Behaviour › Dictation. Every address names the
 * machine by the name this browser shows, exactly as a Settings link does.
 */
const LATER: Readonly<
  Record<MachineSetupTaskId, { readonly tab: MachineTabId; readonly item?: string } | { readonly setting: string }>
> = {
  pair: { tab: 'machine', item: 'devices' },
  start: { tab: 'machine', item: 'clone' },
  claude: { tab: 'runtimes' },
  codex: { tab: 'runtimes' },
  speedups: { tab: 'machine', item: 'speedups' },
  voice: { setting: 'dictation' },
  warden: { tab: 'machine', item: 'warden' },
  learning: { tab: 'machine', item: 'learning' },
  controls: { tab: 'machine' },
};

/** The Settings address a step is revisited at. */
export const onboardingLaterHref = (daemonId: DaemonId, machineName: string, id: MachineSetupTaskId): string => {
  const place = LATER[id];
  const settings = daemonSettingsPath(daemonId);
  if ('setting' in place) return `${settings}#${place.setting}`;
  return `${settings}${place.item === undefined ? machineHash(machineName, place.tab) : machineItemHash(machineName, place.tab, place.item)}`;
};

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

/** What Done says about one step. */
export interface OnboardingDoneRow {
  readonly id: MachineSetupTaskId;
  readonly label: string;
  readonly state: 'set' | 'skipped' | 'not visited';
  /** "cloned from work-mac", "Jev ✓ · Groq not set". Absent when there is nothing to add. */
  readonly detail?: string;
  /** Settings, for every step that is not set. Pairing has none: it is always set by the time you see this. */
  readonly later?: string;
}

/** Facts the steps learned on the way, so Done can say WHAT was set and not only that it was. */
export interface OnboardingDoneFacts {
  /** The machine this one was cloned from, when it was. */
  readonly clonedFrom?: string;
  /** Which speed-up keys the machine holds, by provider label: `{ Jev: true, Groq: false }`. */
  readonly keys?: Readonly<Record<string, boolean>>;
  /** The Warden's own one-line summary. */
  readonly warden?: string;
  readonly passiveDefault?: boolean;
  /** The runtimes each CLI has on the machine now, by name. */
  readonly runtimes?: Readonly<Partial<Record<SetupHarness, readonly string[]>>>;
}

const detailOf = (
  id: MachineSetupTaskId,
  progress: MachineSetupProgress,
  facts: OnboardingDoneFacts,
): string | undefined => {
  switch (id) {
    case 'start':
      if (progress.states.start !== 'done') return undefined;
      if (progress.start === 'fresh') return 'fresh setup';
      return facts.clonedFrom === undefined ? 'clone from another machine' : `cloned from ${facts.clonedFrom}`;
    case 'claude':
    case 'codex': {
      const names = facts.runtimes?.[id];
      return names === undefined || names.length === 0 ? undefined : names.join(', ');
    }
    case 'speedups':
      return facts.keys === undefined
        ? undefined
        : Object.entries(facts.keys)
            .map(([label, set]) => (set ? `${label} ✓` : `${label} not set`))
            .join(' · ');
    case 'warden':
      return facts.warden;
    case 'learning':
      return facts.passiveDefault === undefined
        ? undefined
        : facts.passiveDefault
          ? 'passive on for new ferrets'
          : 'passive off';
    default:
      return undefined;
  }
};

/** One row per step but Done, in rail order: what is set, what was skipped, and where to finish it. */
export const onboardingDoneRows = (
  progress: MachineSetupProgress,
  facts: OnboardingDoneFacts,
  daemonId: DaemonId,
  machineName: string,
): readonly OnboardingDoneRow[] =>
  ONBOARDING_TASKS.map(id => {
    const state = progress.states[id];
    const shown: OnboardingDoneRow['state'] =
      state === 'done' ? 'set' : state === 'skipped' ? 'skipped' : 'not visited';
    const detail = detailOf(id, progress, facts);
    return {
      id,
      label: onboardingStepLabel(id),
      state: shown,
      ...(detail === undefined ? {} : { detail }),
      ...(shown === 'set' || id === 'pair' ? {} : { later: onboardingLaterHref(daemonId, machineName, id) }),
    };
  });

/** The steps still to do, in words: "Speed-ups and Warden", for Done's heading line. */
export const onboardingSkippedSteps = (progress: MachineSetupProgress): readonly MachineSetupTaskId[] =>
  ONBOARDING_TASKS.filter(id => progress.states[id] !== 'done');

// ── Warden ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What the Warden step opens on (R4 step 5): the Jev layer PRESELECTED only when a Jev key was added
 * and the machine is still on the safe default (rules only, which spends nothing). Only Jev: it makes
 * the Warden cheaper to live with, and a flag it does not clear goes to the owner, never to a spend
 * they did not choose. A machine whose owner already chose a layer, or turned the Warden off, keeps
 * that choice; a machine without a Jev key keeps rules only. Preselected is not saved: the step's own
 * Save is what changes the machine.
 */
export const wardenStartingDraft = (config: WardenConfig, jevKeySet: boolean): WardenConfig =>
  jevKeySet && config.enabled && !config.layers.jev && !config.layers.llm
    ? { ...config, layers: { ...config.layers, jev: true } }
    : config;
