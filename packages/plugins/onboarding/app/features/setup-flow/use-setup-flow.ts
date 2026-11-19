/**
 * THE SETUP FLOW'S STATE for one machine: it reads every paired machine's steps ONCE, flattens them, and walks the pages.
 *
 * - The snapshot is taken at the start and never re-read mid-run: a client page that answers writes the device ledger, and
 *   a re-flatten would then drop the very page on screen as `already-set`. Resuming after a reload reads again.
 * - Answers: a daemon step is recorded on the machine (`POST /v1/onboarding/steps/…`); a client step on the device ledger
 *   (done) or the device's later list (later). A failed record never holds the person on a page: the flow moves on and
 *   says "That answer was not saved" with Try again. Each failed answer is kept PER STEP until it is saved (one success
 *   never clears another step's failure), so the end page can say which ones failed.
 * - A later answer may become done (Later → Back → Next records done), but the same answer is never written twice.
 * - Every move a page asks for (Next, Back, Later) names the page visit that issued it; a callback from a page the run
 *   has already left is ignored, so a slow page can never advance whichever page is current.
 * - A plugin's segment memory (`StepHost.segment`) lives HERE, in memory, for this run only. Nothing in this file writes
 *   storage except the two device lists above.
 */
import { daemonOfClient, useEveryDaemon } from '@ferretry/app';
import { readPress } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { StepSegmentMemory } from '@ferretry/kernel/contract';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepState } from '../../../contract/index.ts';
import {
  flattenFlow,
  type Flow,
  type FlowStep,
  type Journey,
  type LedgerStorage,
  type PairedDaemon,
  readLedger,
  recordClientStep,
} from '../../lib/index.ts';
import { onboardingScreen } from '../../onboarding-screen.ts';
import { readLater, rememberLater } from './client-later.ts';
import {
  advance,
  answeredBefore,
  dropPage,
  type Place,
  type ProgressRead,
  type RunState,
  pagesOf,
  progressOf,
  retreat,
  startRun,
} from './flow-model.ts';
import { readFlowAddress } from './flow-href.ts';

/** What the flow needs from its surroundings; the defaults are the browser's. Tests hand in fakes. */
export interface FlowDeps {
  readonly storage?: () => LedgerStorage | undefined;
  readonly now?: () => Instant;
  readonly search?: () => string;
  /** Test seam: how long a page may stay silent under its loading cover. */
  readonly silenceMs?: number;
}

const nowInstant = (): Instant => instantFromEpochMs(Date.now());

const browserLedgerStorage = (): LedgerStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: LedgerStorage }).localStorage;
    return candidate !== undefined && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

type Loading =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ready';
      readonly flow: Flow;
      readonly pages: readonly FlowStep[];
      readonly answered: ReadonlySet<string>;
      readonly journey: Journey;
    };

/** An answer the machine did not take: shown with Try again, and the page itself is long gone. */
export interface Unsaved {
  readonly step: FlowStep;
  readonly state: Exclude<StepState, 'pending'>;
}

type HowAnswered = 'done' | 'later' | 'skipped' | 'found';

export interface SetupFlow {
  readonly loading: 'loading' | 'failed' | 'ready';
  readonly flow: Flow | undefined;
  readonly journey: Journey;
  readonly at: Place;
  readonly direction: RunState['direction'];
  readonly page: FlowStep | undefined;
  readonly canBack: boolean;
  readonly progress: ProgressRead | undefined;
  /** Every answer the machine did not take, oldest first; one entry per step. */
  readonly unsaved: readonly Unsaved[];
  /** The move counter of this run: pass it back with `next`, `back` and `later` so a stale page's call is ignored. */
  readonly visit: number;
  /** The machine this run sets up (and where a client page's panel is drawn when no other carries it). */
  readonly target: string | undefined;
  readonly memoryOf: (plugin: string) => StepSegmentMemory;
  readonly remember: (plugin: string, patch: StepSegmentMemory) => void;
  readonly done: (step: FlowStep) => void;
  readonly skip: (step: FlowStep, why: 'not-needed' | 'already-set') => void;
  readonly next: (key: string, visit: number) => void;
  readonly back: (key: string, visit: number) => void;
  readonly later: (step: FlowStep, visit: number) => void;
  readonly retry: () => void;
  /** The machine's own steps and where each ended: what the closing summary lists (a page that skipped itself is not in it). */
  readonly summary: readonly {
    readonly plugin: string;
    readonly id: string;
    readonly title: string;
    readonly state: StepState;
  }[];
  /** Tries every unsaved answer again. */
  readonly retrySave: () => void;
  /** Tries one step's unsaved answer again. */
  readonly retryStep: (key: string) => void;
}

export function useSetupFlow(client: PluginClient, deps: FlowDeps = {}): SetupFlow {
  const target = daemonOfClient(client);
  const rows = useEveryDaemon();
  // What the flow reads from its surroundings is read when it is needed, so a new object each render restarts nothing.
  const env = useRef({ storage: deps.storage ?? browserLedgerStorage, now: deps.now ?? nowInstant, rows });
  env.current = { storage: deps.storage ?? browserLedgerStorage, now: deps.now ?? nowInstant, rows };
  // The address is read once: the run does not follow later changes to it.
  const [address] = useState(() =>
    readFlowAddress(deps.search?.() ?? (typeof window === 'undefined' ? '' : window.location.search)),
  );
  const [loading, setLoading] = useState<Loading>({ kind: 'loading' });
  const [run, setRun] = useState<RunState>({ at: 'end', trail: [], gone: new Set(), direction: 'forward', visit: 0 });
  const [failed, setFailed] = useState<Readonly<Record<string, Unsaved>>>({});
  /** The newest daemon answer sent per step: an older one's late reply says nothing about the step any more. */
  const sent = useRef(new Map<string, number>());
  /** The run as the last render saw it (for guards that must not wait for the next render). */
  const runNow = useRef<RunState | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  /** How each machine step ended during this run, for the closing summary. */
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, StepState>>>({});
  /** Segment memory: per plugin, this run only, never stored. */
  const memory = useRef(new Map<string, StepSegmentMemory>());
  /** How each page was answered during this run (so Next after a `done()` records nothing twice, and Later may become done). */
  const answeredNow = useRef(new Map<string, HowAnswered>());
  const stage = useRef(loading);
  stage.current = loading;
  runNow.current = run;
  const targetRow = rows.find(row => row.daemon === target);
  const targetReady = targetRow !== undefined;

  // One read of every paired machine, once the machine being set up can be reached.
  useEffect(() => {
    if (target === undefined || !targetReady) return;
    let live = true;
    setLoading({ kind: 'loading' });
    // Try again is the person's own act: its read may raise the passkey prompt a first, quiet read must not.
    const press = attempt > 0 ? readPress(true) : {};
    const read = async (): Promise<void> => {
      const daemons: PairedDaemon[] = [];
      const settled = await Promise.allSettled(
        env.current.rows.map(async row => ({ row, view: await onboardingScreen(row.client).load(press) })),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled')
          daemons.push({
            id: outcome.value.row.daemon,
            name: outcome.value.row.machine,
            steps: outcome.value.view.steps,
          });
      }
      // The machine being set up must answer: without its steps there is no flow to walk.
      if (!daemons.some(daemon => daemon.id === target)) throw new Error('target unreadable');
      const flow = flattenFlow({
        journey: address.journey,
        target,
        daemons,
        ledger: readLedger(env.current.storage()),
        pluginTitles: {},
      });
      const pages = pagesOf(flow);
      const answered = answeredBefore(pages, readLater(env.current.storage()));
      if (!live) return;
      setLoading({ kind: 'ready', flow, pages, answered, journey: address.journey });
      setRun(startRun(pages, answered));
      answeredNow.current = new Map();
      sent.current = new Map();
      setFailed({});
      setOutcomes({});
    };
    read().catch(() => {
      if (live) setLoading({ kind: 'failed' });
    });
    return () => {
      live = false;
    };
  }, [target, targetReady, attempt, address.journey]);

  const ready = loading.kind === 'ready' ? loading : undefined;
  const pages = ready?.pages ?? [];
  const answered = ready?.answered ?? new Set<string>();

  const record = useCallback(
    (step: FlowStep, how: HowAnswered): void => {
      if (target === undefined) return;
      if (step.phase === 'daemon') {
        const state = how;
        const mine = (sent.current.get(step.key) ?? 0) + 1;
        sent.current.set(step.key, mine);
        const newest = (): boolean => sent.current.get(step.key) === mine;
        void onboardingScreen(client)
          .answer(step.plugin, step.id, { state })
          .then(
            () => {
              if (!newest()) return;
              setOutcomes(known => ({ ...known, [step.key]: state }));
              setFailed(known => Object.fromEntries(Object.entries(known).filter(([key]) => key !== step.key)));
            },
            () => {
              if (newest()) setFailed(known => ({ ...known, [step.key]: { step, state } }));
            },
          );
        return;
      }
      const daemon = step.appliesTo[0]?.daemon ?? target;
      if (how === 'later') rememberLater(env.current.storage(), step.key, env.current.now());
      else if (how === 'done' || how === 'found')
        recordClientStep(env.current.storage(), step.plugin, step.id, daemon, env.current.now());
    },
    [client, target],
  );

  /**
   * Writes one answer unless it would repeat what was already written. A later answer may be replaced by a final one
   * (Later → Back → Next records done); a final answer (done, found, skipped) stands, and a repeat of any answer writes nothing.
   */
  const answer = useCallback(
    (step: FlowStep, how: HowAnswered): void => {
      const before = answeredNow.current.get(step.key);
      if (before === how || (before !== undefined && before !== 'later')) return;
      answeredNow.current.set(step.key, how);
      record(step, how);
    },
    [record],
  );
  /** Whether the page that issued a move is still the one on screen (a stale callback is ignored). */
  const current = useCallback(
    (key: string, visit: number): boolean => runNow.current?.at === key && runNow.current.visit === visit,
    [],
  );
  const done = useCallback((step: FlowStep): void => answer(step, 'done'), [answer]);
  const later = useCallback(
    (step: FlowStep, visit: number): void => {
      if (!current(step.key, visit)) return;
      answer(step, 'later');
      setRun(state => (state.at === step.key && state.visit === visit ? advance(state, pages, answered) : state));
    },
    [answer, current, pages, answered],
  );
  const skip = useCallback(
    (step: FlowStep, why: 'not-needed' | 'already-set'): void => {
      // Already set is a fact worth keeping (found / on the ledger); not needed on a machine is the page's own call.
      answer(step, why === 'already-set' ? 'found' : 'skipped');
      setRun(state => dropPage(state, pages, answered, step.key));
    },
    [answer, pages, answered],
  );
  const next = useCallback(
    (key: string, visit: number): void => {
      if (!current(key, visit)) return;
      const here = pages.find(candidate => candidate.key === key);
      if (here !== undefined) done(here);
      setRun(state => (state.at === key && state.visit === visit ? advance(state, pages, answered) : state));
    },
    [current, pages, answered, done],
  );
  const back = useCallback(
    (key: string, visit: number): void =>
      setRun(state => (state.at === key && state.visit === visit ? retreat(state) : state)),
    [],
  );
  const retryStep = useCallback(
    (key: string): void => {
      const unsaved = failed[key];
      if (unsaved !== undefined) record(unsaved.step, unsaved.state);
    },
    [failed, record],
  );
  const retrySave = useCallback((): void => {
    for (const unsaved of Object.values(failed)) record(unsaved.step, unsaved.state);
  }, [failed, record]);

  const page = pages.find(candidate => candidate.key === run.at);
  const progress =
    ready === undefined || page === undefined ? undefined : progressOf(ready.flow, pages, answered, run.gone, page.key);
  return {
    loading: loading.kind,
    flow: ready?.flow,
    journey: address.journey,
    at: run.at,
    direction: run.direction,
    page,
    canBack: run.trail.some(key => !run.gone.has(key)),
    progress,
    unsaved: Object.values(failed),
    visit: run.visit,
    target,
    memoryOf: plugin => memory.current.get(plugin) ?? {},
    remember: (plugin, patch) => {
      memory.current.set(plugin, { ...memory.current.get(plugin), ...patch });
    },
    done,
    skip,
    next,
    back,
    later,
    retry: () => setAttempt(count => count + 1),
    summary:
      ready === undefined
        ? []
        : ready.flow.daemon
            .flatMap(segment => segment.steps)
            .filter(step => !run.gone.has(step.key))
            .map(step => ({
              plugin: step.plugin,
              id: step.id,
              title: step.title,
              state: outcomes[step.key] ?? step.state ?? 'pending',
            })),
    retrySave,
    retryStep,
  };
}
