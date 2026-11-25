/**
 * The ferret tools and the one place that decides "which ferret did they mean" (docs/mcp-connector.md). A ferret is a
 * `FerretSummary` here: `name` is its call sign (first name), `title` its task name.
 */
import { formatTaskRef } from '@ferretry/core-asks/contract';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import { ago, clip, oneLine, tailText } from '../format.ts';
import { type FleetGateway, ToolFailure } from '../gateway.ts';
import { matchExact, matchName, titleVariants } from '../names.ts';
import { type ConnectorToolSpec, READ } from './spec.ts';

const LIST_CAP = 50;
const OUTPUT_DEFAULT_LINES = 40;
const OUTPUT_MAX_LINES = 200;
const OUTPUT_MAX_CHARS = 8000;

export const isLive = (view: FerretSummary): boolean => view.state !== 'stopped';

const titleCase = (word: string): string => (word === '' ? word : word.charAt(0).toUpperCase() + word.slice(1));
/** The name people say: the call sign (the ferret's first name). */
export const callsignOf = (view: FerretSummary): string => titleCase(view.name);
/** The task name people say second: its title, else its call sign. */
const taskOf = (view: FerretSummary): string => view.title ?? view.name;

function stateOf(view: FerretSummary): string {
  if (view.waiting !== undefined) return 'parked, waiting on something it declared';
  switch (view.state) {
    case 'starting':
      return 'starting';
    case 'working':
      return 'working';
    case 'idle':
      return 'idle, waiting for a message';
    case 'stopped':
      return 'stopped';
  }
}

const lastActivity = (view: FerretSummary): string => view.stateAt;

// ---------------------------------------------------------------------------------------------------------
// Ferret resolution
// ---------------------------------------------------------------------------------------------------------

const keysOfFerret = (view: FerretSummary) => ({
  exact: [view.id, view.id.split('-')[0] ?? view.id],
  names: [view.name, ...(view.title === undefined ? [] : titleVariants(view.title))],
});

const describeShort = (view: FerretSummary): string => `${callsignOf(view)} (${clip(oneLine(taskOf(view)), 60)})`;
/** As above, naming the state of one that is not running, so "two Lizzettes" is told apart. */
const describeWithState = (view: FerretSummary): string =>
  isLive(view) ? describeShort(view) : `${describeShort(view)}, ${view.state}`;

/**
 * How careful a name must be. `look` reads: a live ferret is preferred, and a near miss is only suggested. `act` changes
 * something (send, restart, stop, answering for a ferret) and is stricter, because a retried call must meet the SAME ferret
 * again: it never prefers a live ferret over a stopped one it matched as well.
 */
export type ResolveMode = 'look' | 'act';

const manyFailure = (query: string, views: readonly FerretSummary[]): ToolFailure =>
  new ToolFailure(
    `More than one ferret matches "${oneLine(query)}": ${views.slice(0, 5).map(describeWithState).join('; ')}. Which one do you mean?`,
  );

/**
 * The one ferret a spoken name means, or a {@link ToolFailure} that says what to try.
 *
 * EXACT IDENTITIES COME FIRST, across every state: its call sign, id, short id or exact task name. Only when none matches
 * does a prefix or substring count, and then only when exactly one thing matches. That order is what makes "stop lizzette"
 * safe to retry: the first call stops Lizzette, the second finds her stopped ("already stopped") and can never fall through
 * to a different, live ferret whose name merely starts with the same letters.
 *
 * In `look` mode a live ferret is preferred over a stopped one (so a recycled call sign reads the running one). In `act`
 * mode two matches of any state are a question, never a guess; a stopped ferret still matches, so the answer names the right
 * ferret ("stopped") instead of drifting to a live one. What a tool then DOES with a stopped ferret is its own:
 * `send_to_ferret` wakes it with the message, while `restart_ferret` leaves it alone.
 */
export async function resolveFerret(
  gateway: FleetGateway,
  query: string,
  mode: ResolveMode = 'look',
): Promise<FerretSummary> {
  const all = await gateway.ferrets();
  const exact = matchExact(query, all, keysOfFerret);
  if (exact.length === 1) return exact[0] as FerretSummary;
  if (exact.length > 1) {
    const live = exact.filter(isLive);
    if (mode === 'look' && live.length === 1) return live[0] as FerretSummary;
    throw manyFailure(query, exact);
  }
  const pools = mode === 'look' ? [all.filter(isLive), all.filter(view => !isLive(view))] : [all];
  for (const pool of pools) {
    const result = matchName(query, pool, keysOfFerret);
    if (result.kind === 'one') return result.item;
    if (result.kind === 'many') throw manyFailure(query, result.items);
  }
  const near = matchName(query, all, keysOfFerret);
  const hints = near.kind === 'none' ? near.suggestions : [];
  if (hints.length === 0) throw new ToolFailure(`No ferret called "${oneLine(query)}". Ask me to list the ferrets.`);
  throw new ToolFailure(
    `No ferret called "${oneLine(query)}". Did you mean ${hints.map(describeShort).join(', or ')}?`,
  );
}

export const ferretArg = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('Which ferret: its call sign (first name), task name or id.');

const listFerrets: ConnectorToolSpec<Record<string, never>> = {
  name: 'list_ferrets',
  title: 'List ferrets',
  description:
    'List the ferrets (AI agents) running on this machine, one per line: call sign, task, state and how long ago it was last active. Use this first when the user asks what the ferrets are doing.',
  scope: 'fleet:read',
  annotations: READ,
  input: {},
  run: async (_args, env) => {
    const live = (await env.gateway.ferrets()).filter(isLive);
    if (live.length === 0) return { text: 'No ferrets are running.' };
    const shown = live.slice(0, LIST_CAP);
    const lines = shown.map(
      view =>
        `${callsignOf(view)} — ${clip(oneLine(taskOf(view)), 80)} — ${stateOf(view)} — ${ago(env.now(), lastActivity(view))}`,
    );
    const more = live.length > shown.length ? [`…and ${live.length - shown.length} more.`] : [];
    return {
      text: [`${live.length} ${live.length === 1 ? 'ferret' : 'ferrets'} running:`, ...lines, ...more].join('\n'),
    };
  },
};

const getFerret: ConnectorToolSpec<{ ferret: typeof ferretArg }> = {
  name: 'get_ferret',
  title: 'Describe one ferret',
  description:
    'Describe one ferret: its state, current task, what it is waiting on, and why it stopped if it did. Takes its call sign, task name or id.',
  scope: 'fleet:read',
  annotations: READ,
  input: { ferret: ferretArg },
  run: async ({ ferret }, env) => {
    const found = await resolveFerret(env.gateway, ferret);
    // The list answers the ferret as of its last move; the one read is the fresher.
    const view = await env.gateway.ferret(found.id);
    const lines = [
      `${callsignOf(view)}: ${clip(oneLine(taskOf(view)), 120)}.`,
      `State: ${stateOf(view)}. Last active ${ago(env.now(), lastActivity(view))}.`,
    ];
    if (view.task !== undefined) lines.push(`Task: ${formatTaskRef({ id: view.task })}.`);
    if (view.waiting?.condition !== undefined)
      lines.push(`Waiting for: ${clip(oneLine(view.waiting.condition), 200)}.`);
    if (view.state === 'stopped' && view.cause !== undefined) lines.push(`Ended: ${causeWords(view.cause.kind)}.`);
    if (view.quota?.limitNotice !== undefined)
      lines.push(`Last problem: ${clip(oneLine(view.quota.limitNotice), 200)}.`);
    return { text: lines.join('\n'), sessionId: view.id };
  },
};

function causeWords(kind: NonNullable<FerretSummary['cause']>['kind']): string {
  switch (kind) {
    case 'completed':
      return 'it said it was done';
    case 'stopped':
      return 'it was stopped';
    case 'clean_exit':
      return 'its agent exited';
    case 'start_failed':
      return 'it could not start';
    case 'agent_crashed':
      return 'its agent crashed';
    case 'signal':
      return 'its agent was killed';
    case 'terminal_gone':
    case 'tmux_crashed':
      return 'its terminal went away';
  }
}

const getFerretOutput: ConnectorToolSpec<{ ferret: typeof ferretArg; lines: z.ZodOptional<z.ZodNumber> }> = {
  name: 'get_ferret_output',
  title: 'Read recent output',
  description: `Read the most recent output of one ferret (the tail of its conversation), ${OUTPUT_DEFAULT_LINES} lines by default, at most ${OUTPUT_MAX_LINES} lines and ${OUTPUT_MAX_CHARS} characters. Secrets are masked. It says when the output was cut.`,
  scope: 'fleet:read',
  annotations: READ,
  input: {
    ferret: ferretArg,
    lines: z
      .number()
      .int()
      .min(1)
      // Bounded, but not at the cap: a model that asks for 500 lines gets the last OUTPUT_MAX_LINES, not an error.
      .max(100_000)
      .optional()
      .describe(`How many lines, default ${OUTPUT_DEFAULT_LINES}, at most ${OUTPUT_MAX_LINES}.`),
  },
  run: async ({ ferret, lines }, env) => {
    const view = await resolveFerret(env.gateway, ferret);
    const wanted = Math.min(lines ?? OUTPUT_DEFAULT_LINES, OUTPUT_MAX_LINES);
    // Cleaned BEFORE the tail is taken, so a credential is never cut in half and left half-visible.
    const text = await env.clean(await env.gateway.logs(view.id));
    const tail = tailText(text, wanted, OUTPUT_MAX_CHARS);
    if (tail.linesShown === 0) return { text: `${callsignOf(view)} has no output yet.`, sessionId: view.id };
    const note = tail.truncated ? ` Older output was cut; this is the last ${tail.linesShown} lines.` : '';
    return { text: `${callsignOf(view)} recent output:${note}\n${tail.text}`, sessionId: view.id };
  },
};

export const FERRET_TOOLS = [listFerrets, getFerret, getFerretOutput] as const;
