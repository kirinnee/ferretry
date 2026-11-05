/**
 * New machine setup, as data (spec R4, R6; build plan P9).
 *
 * Five steps on ONE PROGRESS RAIL, not a forced stepper and never a stepper inside a step: **Claude Code** →
 * **Codex** → **Speed-ups** → **Defaults** → **Done**, with **Start from** in front only when this browser has
 * another machine to copy. (Pairing is always already done, so it has no step.) Every step can be skipped,
 * any step can be opened from the rail at any time, and every one of them is also a panel in Settings, so a
 * skipped step is never lost. The Claude Code and Codex steps each make their runtime in place
 * (`harness-import-model.ts`): there is no separate runtime wizard.
 *
 * NOTHING HERE IS SENT ANYWHERE. A step saves through its own surface (Speed-ups through the secret route and
 * the Warden's PATCH, Defaults through the voice, learning and agent-control saves); this module only knows
 * where the person is, which steps they finished or skipped, and how to say so. The progress is kept in THIS
 * browser (`setup-progress.ts`) — step ids and two words, never a value from the machine.
 *
 * Pure: the progress in, the next progress and the words out.
 */

import type { FleetAgentControl, WardenConfig } from '@ferretry/protocol';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { daemonSettingsPath } from '../../../lib/pages/routes.ts';
import { type MachineTabId, machineHash } from '../shell/machine-route.ts';
import type { HarnessAnswers } from './harness-import-model.ts';
import { machineItemHash } from './settings-route.ts';
import type { SetupHarness } from './setup-words.ts';

/** The steps, in the order the rail lists them. The ids are what progress stores. */
export const ONBOARDING_STEPS = [
  { id: 'start', label: 'Start from…' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'speedups', label: 'Speed-ups' },
  { id: 'defaults', label: 'Defaults' },
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

/**
 * The steps this setup lists. Start from is there only when another machine can be copied: with none, the
 * first page is Claude Code and no step is spent on a question with one answer.
 */
export const onboardingSteps = (hasSources: boolean): readonly MachineSetupStepId[] =>
  ONBOARDING_STEPS.map(step => step.id).filter(id => hasSources || id !== 'start');

/** `at`, or the first listed step when `at` is not on this setup's rail. */
export const onboardingStepAt = (at: MachineSetupStepId, steps: readonly MachineSetupStepId[]): MachineSetupStepId =>
  steps.includes(at) ? at : (steps[0] ?? 'claude');

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
 * Where a new setup begins: the first listed step (`onboardingStepAt` moves it off Start when there is
 * nothing to copy). Pairing is already done — this screen is only reachable through a pairing, and pairing
 * can never be relayed — so it is not a step at all.
 */
export const ONBOARDING_START: MachineSetupProgress = { at: 'start', states: {}, start: 'fresh' };

export const onboardingStepLabel = (id: MachineSetupStepId): string =>
  (ONBOARDING_STEPS.find(step => step.id === id) as (typeof ONBOARDING_STEPS)[number]).label;

const after = (id: MachineSetupStepId, steps: readonly MachineSetupStepId[]): MachineSetupStepId =>
  steps[Math.min(steps.indexOf(id) + 1, steps.length - 1)] ?? id;

const before = (id: MachineSetupStepId, steps: readonly MachineSetupStepId[]): MachineSetupStepId =>
  steps[Math.max(steps.indexOf(id) - 1, 0)] ?? id;

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
export const continueOnboarding = (
  stored: MachineSetupProgress,
  steps: readonly MachineSetupStepId[],
): MachineSetupProgress => {
  const progress = { ...stored, at: onboardingStepAt(stored.at, steps) };
  return SET_BY_THEIR_OWN_BUTTON.has(progress.at)
    ? skipOnboardingStep(progress, steps)
    : {
        ...progress,
        at: after(progress.at, steps),
        states: isTask(progress.at) ? { ...progress.states, [progress.at]: 'done' } : progress.states,
      };
};

/** The step that follows another, whether or not anyone is on it. */
export const onboardingStepAfter = after;

/**
 * A step's own action worked (an import the daemon did not refuse, keys that tested): it is set, and the
 * page moves on only when the person is still on the visit that asked for it. Someone who tapped Skip or
 * the rail while it ran keeps the page they chose; the step is still set.
 */
export const completeOnboardingStep = (
  progress: MachineSetupProgress,
  id: MachineSetupTaskId,
  stillHere: boolean,
  steps: readonly MachineSetupStepId[],
): MachineSetupProgress =>
  stillHere && onboardingStepAt(progress.at, steps) === id
    ? continueOnboarding(markOnboardingStep(progress, id), steps)
    : markOnboardingStep(progress, id);

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
export const skipOnboardingStep = (
  progress: MachineSetupProgress,
  steps: readonly MachineSetupStepId[],
): MachineSetupProgress => {
  const at = onboardingStepAt(progress.at, steps);
  const keep = !isTask(at) || progress.states[at] === 'done';
  return {
    ...progress,
    at: after(at, steps),
    states: keep ? progress.states : { ...progress.states, [at]: 'skipped' },
  };
};

/** Back one step. Nothing is marked. */
export const backOnboardingStep = (
  progress: MachineSetupProgress,
  steps: readonly MachineSetupStepId[],
): MachineSetupProgress => ({
  ...progress,
  at: before(onboardingStepAt(progress.at, steps), steps),
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

/** "3 of 5 set": the rail's heading, counting the steps this setup lists. */
export const onboardingSetCount = (progress: MachineSetupProgress, steps: readonly MachineSetupStepId[]): string => {
  const tasks = ONBOARDING_TASKS.filter(id => steps.includes(id));
  return `${String(tasks.filter(id => progress.states[id] === 'done').length)} of ${String(tasks.length)} set`;
};

/** The rail's marker for one step: its number, ✓ when set, – when skipped. */
export const onboardingRailMarker = (
  progress: MachineSetupProgress,
  id: MachineSetupStepId,
  steps: readonly MachineSetupStepId[],
): string => {
  const state = isTask(id) ? progress.states[id] : undefined;
  if (state === 'done') return '✓';
  if (state === 'skipped') return '–';
  return String(steps.indexOf(id) + 1);
};

// ── Set up later ─────────────────────────────────────────────────────────────────────────────────

/**
 * Where each step lives in Settings once setup is over: a panel on its tab, a machine tab, or — for the
 * Defaults, whose first row is this DEVICE's voice — Settings › Behaviour › Dictation is the closest
 * single address, so Defaults opens the machine's Agents tab, where the controls and the learning default are.
 * Every address names the machine by the name this browser shows, exactly as a Settings link does.
 */
const LATER: Readonly<Record<MachineSetupTaskId, { readonly tab: MachineTabId; readonly item?: string }>> = {
  start: { tab: 'machine', item: 'clone' },
  claude: { tab: 'runtimes' },
  codex: { tab: 'runtimes' },
  speedups: { tab: 'machine', item: 'speedups' },
  defaults: { tab: 'agents' },
};

/** The Settings address a step is revisited at. */
export const onboardingLaterHref = (daemonId: DaemonId, machineName: string, id: MachineSetupTaskId): string => {
  const place = LATER[id];
  const settings = daemonSettingsPath(daemonId);
  return `${settings}${place.item === undefined ? machineHash(machineName, place.tab) : machineItemHash(machineName, place.tab, place.item)}`;
};

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The machine default speech engine as the Defaults page names it. `device` is NO machine default, not
 * "voice off": a device with no choice of its own still dictates with its own default (Parakeet).
 */
export type DefaultVoice = 'browser' | 'parakeet' | 'device';

/** Facts the steps learned on the way, so Done can say WHAT was set and not only that it was. */
export interface OnboardingDoneFacts {
  /** The machine this one was cloned from, when it was. */
  readonly clonedFrom?: string;
  /** Which speed-up keys the machine holds, by provider label: `{ Jev: true, Groq: false }`. */
  readonly keys?: Readonly<Record<string, boolean>>;
  readonly passiveDefault?: boolean;
  /** The machine's default voice, as `voice.yaml` has it now. */
  readonly voice?: DefaultVoice;
  /** What agents may use on the machine now. */
  readonly agentControl?: FleetAgentControl;
  /** The runtimes each CLI has on the machine now, by name. */
  readonly runtimes?: Readonly<Partial<Record<SetupHarness, readonly string[]>>>;
  /** The runtimes whose login still needs a sign-in, by name, as the machine reads now. */
  readonly needsSignIn?: readonly string[];
}

/** One ✓ or – line on Done. */
export interface OnboardingDoneRow {
  readonly id: 'claude' | 'codex' | 'runtimes' | 'speedups';
  readonly set: boolean;
  readonly text: string;
  /** Settings, for a line that is a – : where to finish it. */
  readonly later?: string;
}

const CLI_NAME: Readonly<Record<SetupHarness, string>> = { claude: 'Claude Code', codex: 'Codex' };

const keysDetail = (keys: Readonly<Record<string, boolean>> | undefined): string | undefined => {
  if (keys === undefined) return undefined;
  const held = Object.entries(keys)
    .filter(([, set]) => set)
    .map(([label]) => label);
  return held.length === 0 ? undefined : held.join(', ');
};

/**
 * Done's two or three lines: each CLI whose import made a runtime, or — when none did — one "No runtime
 * yet" line; and Speed-ups. Defaults are a sentence of their own ({@link onboardingDefaultsSentence}), so a
 * skipped Defaults page is never reported as unset: it is whatever the machine already has.
 */
export const onboardingDoneRows = (
  progress: MachineSetupProgress,
  facts: OnboardingDoneFacts,
  daemonId: DaemonId,
  machineName: string,
): readonly OnboardingDoneRow[] => {
  const made = (['claude', 'codex'] as const).filter(id => (facts.runtimes?.[id] ?? []).length > 0);
  const runtimeRows: readonly OnboardingDoneRow[] =
    made.length === 0
      ? [
          {
            id: 'runtimes',
            set: false,
            text: 'No runtime yet',
            later: onboardingLaterHref(daemonId, machineName, 'claude'),
          },
        ]
      : made.map(id => ({ id, set: true, text: `${CLI_NAME[id]} — ${(facts.runtimes?.[id] ?? []).join(', ')}` }));
  const keys = keysDetail(facts.keys);
  const speedups: OnboardingDoneRow =
    progress.states.speedups === 'done' || keys !== undefined
      ? { id: 'speedups', set: true, text: keys === undefined ? 'Speed-ups saved' : `Speed-ups — ${keys}` }
      : {
          id: 'speedups',
          set: false,
          text: 'Speed-ups skipped',
          later: onboardingLaterHref(daemonId, machineName, 'speedups'),
        };
  return [...runtimeRows, speedups];
};

const VOICE_WORDS: Readonly<Record<DefaultVoice, string>> = {
  browser: 'browser voice',
  parakeet: 'Parakeet voice',
  device: 'each device’s default voice',
};

const CONTROL_WORDS: readonly (readonly [keyof FleetAgentControl, string])[] = [
  ['terminals', 'terminals'],
  ['browsers', 'browsers'],
  ['files', 'files'],
  ['ferretrySettings', 'Ferretry settings'],
  ['pageScripts', 'page scripts'],
];

const joinWords = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;

/** "Defaults: browser voice, learning on, agents may use terminals, browsers and files." — what the machine has now. */
export const onboardingDefaultsSentence = (facts: OnboardingDoneFacts): string => {
  const parts = [
    ...(facts.voice === undefined ? [] : [VOICE_WORDS[facts.voice]]),
    ...(facts.passiveDefault === undefined ? [] : [`learning ${facts.passiveDefault ? 'on' : 'off'}`]),
    ...(facts.agentControl === undefined
      ? []
      : (() => {
          const allowed = CONTROL_WORDS.filter(([kind]) => facts.agentControl?.[kind] === true).map(([, word]) => word);
          return [allowed.length === 0 ? 'agents may use nothing' : `agents may use ${joinWords(allowed)}`];
        })()),
  ];
  return parts.length === 0 ? 'Defaults are set.' : `Defaults: ${parts.join(', ')}.`;
};

/** True only when the machine answered and has no runtime on either CLI: an unread machine claims nothing. */
export const onboardingNeedsRuntime = (facts: OnboardingDoneFacts): boolean =>
  facts.runtimes !== undefined &&
  Object.values(facts.runtimes).every(names => names === undefined || names.length === 0);

// ── Warden ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What the Speed-ups step's "Let the Warden use Jev" box writes once a Jev key was saved: Jev switched on
 * only when the machine is still on the safe default (rules only, which spends nothing). Only Jev: it makes
 * the Warden cheaper to live with, and a flag it does not clear goes to the owner, never to a spend they did
 * not choose. A machine whose owner already chose a layer, or turned the Warden off, keeps that choice.
 */
export const wardenStartingDraft = (config: WardenConfig, jevKeySet: boolean): WardenConfig =>
  jevKeySet && config.enabled && !config.layers.jev && !config.layers.llm
    ? { ...config, layers: { ...config.layers, jev: true } }
    : config;
