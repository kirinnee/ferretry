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
 * - Daemon answers go out ONE AT A TIME per step: while one is in flight a newer intent replaces any queued one, so the machine
 *   (which applies answers in arrival order) always ends on the latest intent, and a retry sends only that latest intent.
 * - The first page is drawn as soon as the machine being set up has answered. Every other paired machine gets a bounded
 *   grace to answer (`PEER_WAIT_MS`); one that is still silent (say, parked behind its own passkey unlock) is left out of
 *   this run, and only the machine being set up is ever asked to unlock.
 * - Every move a page asks for (Next, Back, Later) names the page visit that issued it; a callback from a page the run
 *   has already left is ignored, so a slow page can never advance whichever page is current.
 * - A plugin's segment memory (`StepHost.segment`) lives HERE, in memory, for this run only. Nothing in this file writes
 *   storage except the two device lists above.
 * - A page that is not needed for this run (`StepHost.notNeeded`, contract rule 7) is a mark in the run state ONLY: nothing is
 *   answered or recorded for it, a reload starts with none, and any change to its plugin's segment memory clears that
 *   plugin's marks so its pages are asked again. ONE exception to "nothing recorded": when the run reaches its END, a daemon
 *   page that is STILL marked not needed (a page that was SHOWN can never be marked: the host ignores `notNeeded()` after
 *   `ready()`/`busy(label)`, so only a page that was truly passed over is recorded) is recorded `skipped` on the machine, because a step left `pending` there reopens the first run on every
 *   later visit (steps-opener) and keeps the machine "not set up". That write is final only for the run as it ended: it does
 *   not mark the page answered in this run, so Back -> change the mode -> Next can still record `done` over it.
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
import type { SummaryStep } from '../../views/steps-screen.tsx';
import { readLater, rememberLater } from './client-later.ts';
import {
  advance,
  answeredBefore,
  clearNotNeeded,
  dropPage,
  END,
  markNotNeeded,
  passedOver,
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
  /** Test seam: how long the other paired machines get to answer once the machine being set up has. */
  readonly peerWaitMs?: number;
  /** Test seam: where a flagless page's development report goes (the page frame's default is a development console warning). */
  readonly report?: (message: string) => void;
}

/** How long the other paired machines get to answer after the machine being set up has: a silent one is left out. */
const PEER_WAIT_MS = 1500;

/** One step's daemon answers: at most one in flight, and the newest intent waits as the only queued one. */
interface AnswerLane {
  inFlight: boolean;
  queued: Exclude<StepState, 'pending'> | undefined;
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
  /** The move counter of this run: pass it back with `next`, `back`, `later` and `skip` so a stale page's call is ignored. */
  readonly visit: number;
  /** The machine this run sets up (and where a client page's panel is drawn when no other carries it). */
  readonly target: string | undefined;
  readonly memoryOf: (plugin: string) => StepSegmentMemory;
  readonly remember: (plugin: string, patch: StepSegmentMemory) => void;
  readonly done: (step: FlowStep) => void;
  readonly skip: (step: FlowStep, why: 'not-needed' | 'already-set', visit: number) => void;
  /** The page is not needed for THIS run: passed over, nothing recorded (see `StepHost.notNeeded`). */
  readonly notNeeded: (step: FlowStep, visit: number) => void;
  readonly next: (key: string, visit: number) => void;
  readonly back: (key: string, visit: number) => void;
  readonly later: (step: FlowStep, visit: number) => void;
  readonly retry: () => void;
  /** The machine's own steps and where each ended: what the closing summary lists (a page that skipped itself is not in it). */
  readonly summary: readonly SummaryStep[];
  /** Tries every unsaved answer again. */
  readonly retrySave: () => void;
  /** Tries one step's unsaved answer again. */
  readonly retryStep: (key: string) => void;
}

export function useSetupFlow(client: PluginClient, deps: FlowDeps = {}): SetupFlow {
  const target = daemonOfClient(client);
  const rows = useEveryDaemon();
  // What the flow reads from its surroundings is read when it is needed, so a new object each render restarts nothing.
  const env = useRef({
    storage: deps.storage ?? browserLedgerStorage,
    now: deps.now ?? nowInstant,
    rows,
    peerWaitMs: deps.peerWaitMs ?? PEER_WAIT_MS,
  });
  env.current = {
    storage: deps.storage ?? browserLedgerStorage,
    now: deps.now ?? nowInstant,
    rows,
    peerWaitMs: deps.peerWaitMs ?? PEER_WAIT_MS,
  };
  // The address is read once: the run does not follow later changes to it.
  const [address] = useState(() =>
    readFlowAddress(deps.search?.() ?? (typeof window === 'undefined' ? '' : window.location.search)),
  );
  const [loading, setLoading] = useState<Loading>({ kind: 'loading' });
  const [run, setRun] = useState<RunState>({
    at: 'end',
    trail: [],
    gone: new Set(),
    notNeeded: new Set(),
    direction: 'forward',
    visit: 0,
  });
  const [failed, setFailed] = useState<Readonly<Record<string, Unsaved>>>({});
  /** Each step's answer lane (one write in flight; a newer intent replaces the queued one). Replaced on every read. */
  const lanes = useRef(new Map<string, AnswerLane>());
  /** The run as the last render saw it (for guards that must not wait for the next render). */
  const runNow = useRef<RunState | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  /** How each machine step ended during this run, for the closing summary. */
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, StepState>>>({});
  /** Segment memory: per plugin, this run only, never stored. */
  const memory = useRef(new Map<string, StepSegmentMemory>());
  /** How each page was answered during this run (so Next after a `done()` records nothing twice, and Later may become done). */
  const answeredNow = useRef(new Map<string, HowAnswered>());
  /** The pages the end of the run already told the machine about (a page still marked not needed when the run ends). */
  const toldAtEnd = useRef(new Set<string>());
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
    // Try again is the person's own act: its read may raise the passkey prompt a first, quiet read must not. Only the
    // machine being set up is ever asked that way; the others are read quietly and never hold the run.
    const press = attempt > 0 ? readPress(true) : {};
    const read = async (): Promise<void> => {
      const landed = new Map<string, PairedDaemon>();
      const start = (row: (typeof rows)[number]): Promise<void> =>
        onboardingScreen(row.client)
          .load(row.daemon === target ? press : {})
          .then(view => {
            landed.set(row.daemon, { id: row.daemon, name: row.machine, steps: view.steps });
          });
      const everyRow = env.current.rows;
      const mine = everyRow.find(row => row.daemon === target);
      const others = everyRow.filter(row => row.daemon !== target);
      // Start every read together, then wait for the machine being set up alone: it must answer or there is no flow.
      const peerReads = others.map(row => start(row).catch(() => undefined));
      if (mine === undefined) throw new Error('target unreadable');
      await start(mine);
      // The others get a bounded grace; whoever has not answered by then is left out of this run (never awaited again).
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(peerReads),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, env.current.peerWaitMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      const daemons = everyRow.flatMap(row => landed.get(row.daemon) ?? []);
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
      toldAtEnd.current = new Set();
      lanes.current = new Map();
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

  /**
   * Sends one daemon answer for a step: one write in flight per step, and a newer intent replaces any queued one, so the
   * machine always ends on the latest intent whatever order replies come back in. A newer intent also withdraws the step's
   * old failure (it is no longer what the person wants), so Try again can only ever resend the latest answer.
   */
  const sendDaemon = useCallback(
    (step: FlowStep, state: Exclude<StepState, 'pending'>): void => {
      const mine = lanes.current;
      const lane = mine.get(step.key) ?? { inFlight: false, queued: undefined };
      mine.set(step.key, lane);
      lane.queued = state;
      setFailed(known =>
        step.key in known ? Object.fromEntries(Object.entries(known).filter(([key]) => key !== step.key)) : known,
      );
      if (lane.inFlight) return;
      const pump = (): void => {
        const intent = lane.queued;
        if (intent === undefined) {
          lane.inFlight = false;
          return;
        }
        lane.queued = undefined;
        lane.inFlight = true;
        void onboardingScreen(client)
          .answer(step.plugin, step.id, { state: intent })
          .then(
            () => {
              if (mine !== lanes.current) return;
              if (lane.queued === undefined) setOutcomes(known => ({ ...known, [step.key]: intent }));
            },
            () => {
              if (mine !== lanes.current) return;
              if (lane.queued === undefined) setFailed(known => ({ ...known, [step.key]: { step, state: intent } }));
            },
          )
          .finally(() => {
            if (mine === lanes.current) pump();
            else lane.inFlight = false;
          });
      };
      pump();
    },
    [client],
  );

  const record = useCallback(
    (step: FlowStep, how: HowAnswered): void => {
      if (target === undefined) return;
      if (step.phase === 'daemon') {
        sendDaemon(step, how);
        return;
      }
      const daemon = step.appliesTo[0]?.daemon ?? target;
      if (how === 'later') rememberLater(env.current.storage(), step.key, env.current.now());
      else if (how === 'done' || how === 'found')
        recordClientStep(env.current.storage(), step.plugin, step.id, daemon, env.current.now());
    },
    [sendDaemon, target],
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
    (step: FlowStep, why: 'not-needed' | 'already-set', visit: number): void => {
      if (!current(step.key, visit)) return;
      // Already set is a fact worth keeping (found / on the ledger); not needed on a machine is the page's own call.
      answer(step, why === 'already-set' ? 'found' : 'skipped');
      setRun(state => dropPage(state, pages, answered, step.key));
    },
    [answer, current, pages, answered],
  );
  const notNeeded = useCallback(
    (step: FlowStep, visit: number): void => {
      if (!current(step.key, visit)) return;
      setRun(state => markNotNeeded(state, pages, answered, step.key));
    },
    [current, pages, answered],
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

  // The run ended: what is still passed over will never be asked, so the machine hears it was skipped (see the header).
  useEffect(() => {
    if (run.at !== END) return;
    for (const key of run.notNeeded) {
      const step = pages.find(candidate => candidate.key === key);
      if (step?.phase !== 'daemon' || answeredNow.current.has(key) || toldAtEnd.current.has(key)) continue;
      toldAtEnd.current.add(key);
      sendDaemon(step, 'skipped');
    }
  }, [run.at, run.notNeeded, pages, sendDaemon]);

  const page = pages.find(candidate => candidate.key === run.at);
  const hidden = passedOver(run);
  const progress =
    ready === undefined || page === undefined ? undefined : progressOf(ready.flow, pages, answered, hidden, page.key);
  return {
    loading: loading.kind,
    flow: ready?.flow,
    journey: address.journey,
    at: run.at,
    direction: run.direction,
    page,
    canBack: run.trail.some(key => !hidden.has(key)),
    progress,
    unsaved: Object.values(failed),
    visit: run.visit,
    target,
    memoryOf: plugin => memory.current.get(plugin) ?? {},
    remember: (plugin, patch) => {
      const before = memory.current.get(plugin) ?? {};
      memory.current.set(plugin, { ...before, ...patch });
      // An answer that CHANGED may change what its plugin's other pages need, so they are asked again.
      if (Object.entries(patch).some(([key, value]) => before[key] !== value))
        setRun(state => clearNotNeeded(state, pages, plugin));
    },
    done,
    skip,
    notNeeded,
    next,
    back,
    later,
    retry: () => setAttempt(count => count + 1),
    summary:
      ready === undefined
        ? []
        : ready.flow.daemon.flatMap(segment =>
            segment.steps
              .filter(step => !hidden.has(step.key))
              .map(step => ({
                plugin: step.plugin,
                id: step.id,
                title: step.title,
                group: segment.group,
                state: outcomes[step.key] ?? step.state ?? 'pending',
              })),
          ),
    retrySave,
    retryStep,
  };
}
