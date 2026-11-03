#!/usr/bin/env bun
// Replays a real session's recorded ferret mail through the REAL queue rules (`SessionQueueService.enqueue`
// for the hold, `planDelivery` for the decision) and prints how many turns it would have cost.
//
//   bun scripts/local/simulate-message-coalescing.ts <session-dir> [--window-ms N] [--fyi-cap-ms N] [--batch-max N]
//
// Read-only: it reads `<session-dir>/channel/inbox.jsonl` (arrivals) and `<session-dir>/events.jsonl`
// (the receiver's recorded `turn.state` timeline) and writes nothing.
//
// Three labellings of the same ferret mail:
//   floor      every ferret message is an `action`     (nobody sends an FYI: only the 60 s window helps)
//   heuristic  "No reply needed." in the text -> fyi; "blocked / stuck / urgent …" -> blocker; the rest -> action
//   ceiling    every ferret message is labelled `fyi`  (a question is a blocker: it is never held)
//
// A message is a QUESTION only when its banner says so (`[question from ferret …]`, read with the protocol's
// own `parsePeerEnvelope`); a message with any other banner, or none the parser knows, is not one.
//
// CAVEATS. The turn timeline is the RECORDED one, not a counterfactual: fewer, bigger turns would change when
// the receiver is idle. Delivery is instant (no typing time), the session is always `running`, and the labels
// are guessed from the text, not chosen by a sender. Read the numbers as a size, not a forecast.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePeerEnvelope, type QueuedMessage } from '../../packages/protocol/src/lib/index.ts';
import {
  defaultQueueCoalesceSettings,
  planDelivery,
  type QueueCoalesceSettings,
  type QueueEvent,
  SessionQueueService,
} from '../../packages/daemon/src/lib/index.ts';
import { parseSessionId } from '../../packages/daemon/src/lib/session-id.ts';

type Label = 'blocker' | 'action' | 'fyi';
type Scenario = 'floor' | 'heuristic' | 'ceiling';

interface Arrival {
  readonly at: number;
  readonly kind: 'ferret' | 'owner' | 'daemon';
  readonly text: string;
  /** The banner says the sender is waiting for an answer. */
  readonly question: boolean;
  /** The text itself says no answer is wanted (the heuristic labelling's only FYI signal). */
  readonly noReplyNeeded: boolean;
}

interface TurnState {
  readonly at: number;
  readonly to: string;
}

const SESSION = parseSessionId('simulation');
const BLOCKER_WORDS = /\b(blocked|stuck|urgent|please decide|need your|cannot continue|can't continue)\b/i;

const jsonLines = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as unknown);

function readArrivals(dir: string): Arrival[] {
  return jsonLines(join(dir, 'channel', 'inbox.jsonl'))
    .map(row => row as { at: string; message: string; from?: string })
    .map(row => ({
      at: Date.parse(row.at),
      kind:
        row.from !== undefined
          ? ('ferret' as const)
          : row.message.startsWith('[ferretry] ')
            ? ('daemon' as const)
            : ('owner' as const),
      text: row.message,
      question: parsePeerEnvelope(row.message)?.envelope.replyExpected === true,
      noReplyNeeded: row.message.includes('No reply needed.'),
    }))
    .sort((left, right) => left.at - right.at);
}

function readTurnStates(dir: string): TurnState[] {
  return jsonLines(join(dir, 'events.jsonl'))
    .map(row => row as { time: string; type: string; data: { to?: string } })
    .filter(row => row.type === 'turn.state' && typeof row.data.to === 'string')
    .map(row => ({ at: Date.parse(row.time), to: row.data.to as string }))
    .sort((left, right) => left.at - right.at);
}

/** The receiver's state at an instant, and when it last changed. */
function stateAt(states: readonly TurnState[], instant: number): { to: string; since: number } {
  let low = 0;
  let high = states.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((states[middle] as TurnState).at <= instant) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const state = states[found];
  return state === undefined ? { to: 'working', since: 0 } : { to: state.to, since: state.at };
}

function labelOf(scenario: Scenario, arrival: Arrival): Label {
  if (scenario === 'floor') return 'action';
  if (scenario === 'ceiling') return 'fyi';
  if (BLOCKER_WORDS.test(arrival.text)) return 'blocker';
  return arrival.noReplyNeeded ? 'fyi' : 'action';
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);

interface Outcome {
  readonly ferretMessages: number;
  readonly turnsBefore: number;
  readonly turnsAfter: number;
  readonly wakesBefore: number;
  readonly wakesAfter: number;
  readonly latencies: Readonly<Record<string, readonly number[]>>;
  readonly largestBatch: number;
}

async function run(
  scenario: Scenario,
  arrivals: readonly Arrival[],
  states: readonly TurnState[],
  settings: QueueCoalesceSettings,
): Promise<Outcome> {
  let clock = 0;
  const log: QueueEvent[] = [];
  const service = new SessionQueueService(
    {
      store: { read: async () => [...log], append: async (_id, event) => void log.push(event) },
      clock: { now: () => new Date(clock).toISOString() },
      serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
    },
    settings,
  );

  const pending: QueuedMessage[] = [];
  const arrivedAt = new Map<string, number>();
  const labelFor = new Map<string, string>();
  const latencies: Record<string, number[]> = { blocker: [], action: [], fyi: [] };
  let turnsAfter = 0;
  let wakesAfter = 0;
  let largestBatch = 0;
  const timers: number[] = [];
  const stateChanges = states.map(state => state.at);

  const deliverDue = (instant: number): void => {
    clock = instant;
    for (;;) {
      const current = stateAt(states, instant);
      const target = {
        id: SESSION,
        status: 'running' as const,
        mode: 'auto' as const,
        turn: 1,
        turnState: current.to,
        turnStateAt: new Date(current.since).toISOString(),
      };
      const plan = planDelivery(pending, { target }, new Date(instant).toISOString(), settings);
      if (plan === undefined) return;
      if (plan.kind === 'hold') {
        if (plan.until !== undefined) timers.push(Date.parse(plan.until));
        return;
      }
      const members = plan.kind === 'single' ? [plan.message] : plan.members;
      const ferrets = members.filter(member => member.sender === 'agent');
      if (ferrets.length > 0) {
        turnsAfter += 1;
        if (current.to === 'your-turn') wakesAfter += 1;
        largestBatch = Math.max(largestBatch, ferrets.length);
      }
      for (const member of members) {
        const arrived = arrivedAt.get(member.id) as number;
        if (member.sender === 'agent') latencies[labelFor.get(member.id) as string]?.push(instant - arrived);
        pending.splice(pending.indexOf(member), 1);
      }
    }
  };

  // One merged, ordered walk over arrivals, recorded turn changes and the hold expiries the plan asked for.
  let index = 0;
  let turnsBefore = 0;
  let wakesBefore = 0;
  let ferretMessages = 0;
  let nextState = 0;
  for (;;) {
    const arrival = arrivals[index];
    const timer = timers.length === 0 ? undefined : Math.min(...timers);
    const change = nextState < stateChanges.length ? (stateChanges[nextState] as number) : undefined;
    const candidates = [arrival?.at, timer, change].filter((value): value is number => value !== undefined);
    if (candidates.length === 0 || (arrival === undefined && pending.length === 0)) break;
    const instant = Math.min(...candidates);
    while (timers.length > 0 && Math.min(...timers) <= instant) timers.splice(timers.indexOf(Math.min(...timers)), 1);
    while (nextState < stateChanges.length && (stateChanges[nextState] as number) <= instant) nextState += 1;
    clock = instant;
    while (arrivals[index] !== undefined && (arrivals[index] as Arrival).at <= instant) {
      const next = arrivals[index] as Arrival;
      index += 1;
      const id = `m${index}`;
      if (next.kind === 'ferret') {
        ferretMessages += 1;
        turnsBefore += 1;
        if (stateAt(states, next.at).to === 'your-turn') wakesBefore += 1;
        const label = labelOf(scenario, next);
        labelFor.set(id, label);
        const { message } = await service.enqueue(SESSION, {
          id,
          sender: 'agent',
          from: 'peer',
          text: next.text,
          label,
          ...(next.question ? { replyExpected: true } : {}),
        });
        pending.push(message);
      } else {
        const { message } = await service.enqueue(SESSION, {
          id,
          sender: next.kind === 'owner' ? 'human' : 'daemon',
          text: next.text,
        });
        pending.push(message);
      }
      arrivedAt.set(id, next.at);
    }
    deliverDue(instant);
  }

  return { ferretMessages, turnsBefore, turnsAfter, wakesBefore, wakesAfter, latencies, largestBatch };
}

const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)} s`;

function flag(args: readonly string[], name: string, fallback: number): number {
  const at = args.indexOf(name);
  const value = at === -1 ? undefined : Number(args[at + 1]);
  return value === undefined || Number.isNaN(value) ? fallback : value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find(arg => !arg.startsWith('--') && !/^\d+$/.test(arg));
  if (dir === undefined) {
    console.error(
      'usage: bun scripts/local/simulate-message-coalescing.ts <session-dir> [--window-ms N] [--fyi-cap-ms N] [--batch-max N]',
    );
    process.exit(2);
  }
  const settings: QueueCoalesceSettings = {
    ...defaultQueueCoalesceSettings,
    actionWindowMs: flag(args, '--window-ms', defaultQueueCoalesceSettings.actionWindowMs),
    fyiMaxHoldMs: flag(args, '--fyi-cap-ms', defaultQueueCoalesceSettings.fyiMaxHoldMs),
    batchMax: flag(args, '--batch-max', defaultQueueCoalesceSettings.batchMax),
  };
  const arrivals = readArrivals(dir);
  const states = readTurnStates(dir);
  const ferrets = arrivals.filter(arrival => arrival.kind === 'ferret');
  const gaps = ferrets.slice(1).map((arrival, at) => arrival.at - (ferrets[at] as Arrival).at);
  console.log(`session ${dir}`);
  console.log(
    `${arrivals.length} messages: ${ferrets.length} ferret, ${arrivals.filter(a => a.kind === 'owner').length} owner, ${arrivals.filter(a => a.kind === 'daemon').length} daemon; ${states.length} recorded turn.state rows`,
  );
  console.log(
    `gaps between consecutive ferret messages: ${gaps.filter(g => g < 60_000).length} < 60 s, ${gaps.filter(g => g < 600_000).length} < 10 min (of ${gaps.length})`,
  );
  console.log(
    `settings: window ${seconds(settings.actionWindowMs)}, fyi cap ${seconds(settings.fyiMaxHoldMs)}, batch max ${settings.batchMax}\n`,
  );

  for (const scenario of ['floor', 'heuristic', 'ceiling'] as const) {
    const outcome = await run(scenario, arrivals, states, settings);
    const saved = outcome.turnsBefore - outcome.turnsAfter;
    console.log(`== ${scenario}`);
    console.log(
      `delivered ferret turns   before ${outcome.turnsBefore}   after ${outcome.turnsAfter}   (-${saved}, ${((saved / Math.max(1, outcome.turnsBefore)) * 100).toFixed(1)}%)   largest batch ${outcome.largestBatch}`,
    );
    console.log(`idle wakes (receiver at your-turn)   before ${outcome.wakesBefore}   after ${outcome.wakesAfter}`);
    for (const label of ['blocker', 'action', 'fyi'] as const) {
      const sorted = [...(outcome.latencies[label] ?? [])].sort((left, right) => left - right);
      if (sorted.length === 0) continue;
      console.log(
        `added latency ${label.padEnd(7)} n=${String(sorted.length).padStart(4)}   p50 ${seconds(percentile(sorted, 0.5))}   p95 ${seconds(percentile(sorted, 0.95))}   max ${seconds(sorted.at(-1) as number)}`,
      );
    }
    console.log('');
  }
}

await main();
