/**
 * FLATTENING: every plugin's declared steps become ONE linear flow (pure; no React, no storage, no clock).
 *
 * Two phases. The DAEMON phase is the machine being set up: its daemon-side steps, grouped by plugin. The CLIENT phase is
 * this browser: the client-side steps of every paired daemon, de-duplicated by `<plugin>.<step>`, so a step two daemons
 * share is asked once, and a step only some daemons carry says so (`onlyOn`). A client step already on the device ledger
 * is marked `already-set`; it stays in the list (the progress bar can say "skipped") but the flow never mounts it.
 *
 * A plugin's steps stay together (a SEGMENT: "Claude Code · 3 of 7"). Segments sort by their lowest `order`, with
 * Onboarding's own pages (name, appearance) first; steps inside a segment sort by `order`, then id. The shell knows no
 * plugin's logic: a step that decides it is not needed says so itself when it mounts (`StepHost.skip`).
 */
import { type StepView, sideOf } from '../../contract/index.ts';
import { clientStepKey } from '../../contract/step-host.ts';
import { type ClientLedger, isClientStepSet } from './client-ledger.ts';

export type Journey = 'first-time' | 'pair' | 'add-daemon';
export type Phase = 'daemon' | 'client';

/** One paired daemon and the steps its `GET /v1/onboarding` returned. */
export interface PairedDaemon {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly StepView[];
}

export interface FlowStep {
  /** `<plugin>.<step>`: the panel `subject` and the ledger key. */
  readonly key: string;
  readonly plugin: string;
  readonly id: string;
  readonly title: string;
  readonly phase: Phase;
  readonly order: number;
  /** The daemons that carry this step (for a daemon step: the machine being set up). */
  readonly appliesTo: readonly { readonly daemon: string; readonly name: string }[];
  /** Machine names to put in the "Only on <machine>" chip; empty when the step applies to every paired daemon. */
  readonly onlyOn: readonly string[];
  /** The step's page is written against `StepHost`: the shell draws it under a loading cover. Without it the page is a legacy one: no cover, Next enabled, done recorded on Next. */
  readonly stepHost: boolean;
  /** Set when the flow never mounts the step. */
  readonly skip?: 'already-set';
  /** A daemon step's recorded state on the machine (`pending` when nothing was recorded); client steps have none. */
  readonly state?: StepView['state'];
}

export interface FlowSegment {
  readonly plugin: string;
  /** The progress bar's title for the segment. */
  readonly group: string;
  readonly phase: Phase;
  readonly steps: readonly FlowStep[];
}

export interface Flow {
  readonly daemon: readonly FlowSegment[];
  readonly client: readonly FlowSegment[];
}

export interface FlattenInput {
  readonly journey: Journey;
  /** The daemon being set up (and, for Pair, the one just paired). */
  readonly target: string;
  /** Every paired daemon on this device, the target included. */
  readonly daemons: readonly PairedDaemon[];
  readonly ledger: ClientLedger;
  /** Plugin titles for the default group name; a plugin missing here is shown as its id in words. */
  readonly pluginTitles?: Readonly<Record<string, string>>;
}

/** The shell's own plugin: its pages (name this machine, appearance) always lead their phase. */
const SHELL_PLUGIN = 'onboarding';

/** `claude-code` → `Claude Code`. */
export const wordsOf = (id: string): string =>
  id
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const byOrder = (a: FlowStep, b: FlowStep): number => a.order - b.order || a.id.localeCompare(b.id);

function segmentsOf(
  steps: readonly FlowStep[],
  groups: ReadonlyMap<string, string>,
  titles: Readonly<Record<string, string>>,
  phase: Phase,
): readonly FlowSegment[] {
  const byPlugin = new Map<string, FlowStep[]>();
  for (const step of steps) byPlugin.set(step.plugin, [...(byPlugin.get(step.plugin) ?? []), step]);
  return [...byPlugin.entries()]
    .map(([plugin, list]) => ({
      plugin,
      group: groups.get(plugin) ?? titles[plugin] ?? wordsOf(plugin),
      phase,
      steps: [...list].sort(byOrder),
    }))
    .sort(
      (a, b) =>
        Number(b.plugin === SHELL_PLUGIN) - Number(a.plugin === SHELL_PLUGIN) ||
        (a.steps[0]?.order ?? 0) - (b.steps[0]?.order ?? 0) ||
        a.plugin.localeCompare(b.plugin),
    );
}

export function flattenFlow(input: FlattenInput): Flow {
  const titles = input.pluginTitles ?? {};
  const target = input.daemons.find(daemon => daemon.id === input.target);
  const groups = new Map<string, string>();
  const rememberGroup = (step: StepView): void => {
    if (step.group !== undefined && !groups.has(step.plugin)) groups.set(step.plugin, step.group);
  };

  // Daemon phase: only for a journey that sets a daemon up, only the target's daemon-side steps.
  const daemonSteps: FlowStep[] =
    input.journey === 'pair' || target === undefined
      ? []
      : target.steps
          .filter(step => sideOf(step) === 'daemon')
          .map(step => {
            rememberGroup(step);
            return {
              key: clientStepKey(step.plugin, step.id),
              plugin: step.plugin,
              id: step.id,
              title: step.title,
              phase: 'daemon' as const,
              order: step.order,
              appliesTo: [{ daemon: target.id, name: target.name }],
              onlyOn: [],
              stepHost: step.stepHost === true,
              state: step.state,
            };
          });

  // Client phase: client steps over the paired daemons, one entry per `<plugin>.<step>`.
  const wanted = (daemon: PairedDaemon): boolean => input.journey !== 'add-daemon' || daemon.id === input.target;
  const found = new Map<string, { step: StepView; on: PairedDaemon[]; wanted: boolean }>();
  for (const daemon of input.daemons) {
    for (const step of daemon.steps) {
      if (sideOf(step) !== 'client') continue;
      const key = clientStepKey(step.plugin, step.id);
      const known = found.get(key);
      if (known === undefined) found.set(key, { step, on: [daemon], wanted: wanted(daemon) });
      else {
        known.on.push(daemon);
        known.wanted ||= wanted(daemon);
      }
    }
  }
  const clientSteps: FlowStep[] = [...found.entries()]
    // Set up a new daemon: only the client steps of THIS daemon's plugins (the ledger then skips what is set).
    .filter(([, entry]) => entry.wanted)
    .map(([key, { step, on }]) => {
      rememberGroup(step);
      const partial = on.length < input.daemons.length;
      return {
        key,
        plugin: step.plugin,
        id: step.id,
        title: step.title,
        phase: 'client' as const,
        order: step.order,
        appliesTo: on.map(daemon => ({ daemon: daemon.id, name: daemon.name })),
        onlyOn: partial ? on.map(daemon => daemon.name) : [],
        stepHost: step.stepHost === true,
        ...(isClientStepSet(input.ledger, step.plugin, step.id) ? { skip: 'already-set' as const } : {}),
      };
    });

  return {
    daemon: segmentsOf(daemonSteps, groups, titles, 'daemon'),
    client: segmentsOf(clientSteps, groups, titles, 'client'),
  };
}

/** Every step of a phase in flow order. */
export const stepsOf = (segments: readonly FlowSegment[]): readonly FlowStep[] =>
  segments.flatMap(segment => segment.steps);

/** The steps the flow will mount: everything not marked skipped. */
export const askableSteps = (segments: readonly FlowSegment[]): readonly FlowStep[] =>
  stepsOf(segments).filter(step => step.skip === undefined);

/**
 * Where to resume: the first askable step with no answer yet. A daemon step is answered once the machine recorded
 * anything but `pending` (`found`, `later`, `skipped`, `done`); a client step is answered when the ledger has it, which
 * is the `already-set` skip, so an askable client step is always unanswered. `undefined` when the phase is finished.
 */
export function firstUnanswered(segments: readonly FlowSegment[]): FlowStep | undefined {
  return askableSteps(segments).find(step => step.phase === 'client' || step.state === 'pending');
}
