/**
 * The nine tools, as data: what each is called, who may call it, what it says to a voice assistant and what it
 * does through the daemon's own API. The MCP adapter (`adapters/connector/mcp`) registers these with the SDK;
 * nothing here knows about HTTP or the SDK, so the whole behaviour is unit-tested with a fake dispatch.
 *
 * RESULTS ARE SHORT PLAIN TEXT, because they are often read aloud: no JSON, no tables, one idea per line.
 * Every text that came from a ferret or the daemon is passed through {@link ConnectorTextGuard} by
 * {@link ConnectorToolbox.execute} — the tools themselves never decide what is safe to say.
 *
 * "Call sign": in Ferretry v4 every session has a first name, its callsign (`config.teammate`, e.g. `lizzette`),
 * which people say out loud. Its task title is `config.name`. A tool that takes `ferret` accepts either, or the
 * session id or its short id (the first segment of the id), matched by `names.ts`.
 */

import type { AgendaItem, AgendaKind, AgendaResponse, SessionView } from '@ferretry/protocol';
import { formatTaskRef } from '@ferretry/protocol/board-refs';
import { z } from 'zod';
import type { ConnectorAccess, ConnectorAuditSink, ConnectorScope, ConnectorToolOutcome } from '../ports.ts';
import { type ConnectorToolName, daemonGrantRefusal } from './demands.ts';
import { ago, clip, oneLine, tailText } from './format.ts';
import { type FleetGateway, type OpenAgendaItem, ToolFailure } from './gateway.ts';
import { matchExact, matchName, titleVariants } from './names.ts';
import type { ConnectorCallsLog, DaemonGrantsSource } from './ports.ts';
import type { ConnectorTextGuard } from './redaction.ts';
import { WITHHELD } from './redaction.ts';

export const LIST_CAP = 50;
export const ATTENTION_CAP = 30;
export const OUTPUT_DEFAULT_LINES = 40;
export const OUTPUT_MAX_LINES = 200;
export const OUTPUT_MAX_CHARS = 8000;
export const MESSAGE_MAX_CHARS = 8000;
const LOG_ARG_CUT = 500;

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
}

/** What a tool says back: the sentence(s), and the session it touched (for the security log). */
export interface ToolOutput {
  readonly text: string;
  readonly isError?: true;
  readonly sessionId?: string;
}

export interface ToolEnvironment {
  readonly gateway: FleetGateway;
  readonly now: () => number;
  /** The redaction door, for a tool that must cut text AFTER it is clean (output tails). */
  readonly clean: (text: string) => Promise<string>;
}

export interface ConnectorToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: ConnectorToolName;
  readonly title: string;
  readonly description: string;
  readonly scope: ConnectorScope;
  readonly annotations: ToolAnnotations;
  readonly input: Shape;
  readonly run: (args: z.infer<z.ZodObject<Shape>>, env: ToolEnvironment) => Promise<ToolOutput>;
}

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'stalled', 'stopped'];
const isLive = (view: SessionView): boolean => !TERMINAL_STATUSES.includes(view.state.status);

const titleCase = (word: string): string => (word === '' ? word : word.charAt(0).toUpperCase() + word.slice(1));
/** The name people say: the callsign, else the task title. */
export const callsignOf = (view: SessionView): string => titleCase(view.config.teammate ?? view.config.name);

function stateOf(view: SessionView): string {
  const { state } = view;
  if (state.waiting !== undefined) return 'parked, waiting on something it declared';
  if (state.turnState === 'needs-input') return 'blocked, needs a person';
  if (state.turnState === 'your-turn') return 'idle, waiting for a message';
  if (state.turnState === 'working') return 'working';
  switch (state.status) {
    case 'rate_limited':
      return 'paused by a usage limit';
    case 'retrying':
      return 'retrying';
    case 'awaiting_question':
    case 'awaiting_user':
      return 'waiting for an answer';
    case 'kill_failed':
      return 'stuck, could not be stopped';
    case 'created':
    case 'starting':
      return 'starting';
    case 'running':
    case 'thinking':
    case 'tool_running':
      return 'working';
    default:
      return state.status;
  }
}

const lastActivity = (view: SessionView): string | undefined =>
  view.state.lastActivityAt ?? view.state.lastTranscriptAt ?? view.config.updatedAt;

// ---------------------------------------------------------------------------------------------------------
// Ferret resolution
// ---------------------------------------------------------------------------------------------------------

const keysOfSession = (view: SessionView) => ({
  exact: [view.config.id, view.config.id.split('-')[0] ?? view.config.id],
  names: [...(view.config.teammate === undefined ? [] : [view.config.teammate]), ...titleVariants(view.config.name)],
});

const describeShort = (view: SessionView): string => `${callsignOf(view)} (${clip(oneLine(view.config.name), 60)})`;
/** As above, naming the state of one that is not running, so "two Lizzettes" is told apart. */
const describeWithState = (view: SessionView): string =>
  isLive(view) ? describeShort(view) : `${describeShort(view)}, ${view.state.status}`;

/**
 * How careful a name must be. `look` reads: a live ferret is preferred, and a near miss is only suggested.
 * `act` changes something (send, restart, stop, answering for a ferret) and is stricter, because a retried call
 * must meet the SAME ferret again: it never prefers a live ferret over a stopped one it matched as well.
 */
type ResolveMode = 'look' | 'act';

const manyFailure = (query: string, views: readonly SessionView[]): ToolFailure =>
  new ToolFailure(
    `More than one ferret matches "${oneLine(query)}": ${views.slice(0, 5).map(describeWithState).join('; ')}. Which one do you mean?`,
  );

/**
 * The one ferret a spoken name means, or a {@link ToolFailure} that says what to try.
 *
 * EXACT IDENTITIES COME FIRST, across every state: its callsign, session id, short id or exact task name.
 * Only when none matches does a prefix or substring count, and then only when exactly one thing matches.
 * That order is what makes "stop lizzette" safe to retry: the first call stops Lizzette, the second finds her
 * stopped ("already stopped") and can never fall through to a different, live ferret whose name merely starts
 * with the same letters.
 *
 * In `look` mode a live ferret is preferred over a stopped one (so a recycled callsign reads the running
 * one). In `act` mode two matches of any state are a question, never a guess; a stopped ferret still matches,
 * so "restart lizzette" can wake it.
 */
export async function resolveFerret(
  gateway: FleetGateway,
  query: string,
  mode: ResolveMode = 'look',
): Promise<SessionView> {
  const all = await gateway.sessions();
  const exact = matchExact(query, all, keysOfSession);
  if (exact.length === 1) return exact[0] as SessionView;
  if (exact.length > 1) {
    const live = exact.filter(isLive);
    if (mode === 'look' && live.length === 1) return live[0] as SessionView;
    throw manyFailure(query, exact);
  }
  const pools = mode === 'look' ? [all.filter(isLive), all.filter(view => !isLive(view))] : [all];
  for (const pool of pools) {
    const result = matchName(query, pool, keysOfSession);
    if (result.kind === 'one') return result.item;
    if (result.kind === 'many') throw manyFailure(query, result.items);
  }
  const near = matchName(query, all, keysOfSession);
  const hints = near.kind === 'none' ? near.suggestions : [];
  if (hints.length === 0) throw new ToolFailure(`No ferret called "${oneLine(query)}". Ask me to list the ferrets.`);
  throw new ToolFailure(
    `No ferret called "${oneLine(query)}". Did you mean ${hints.map(describeShort).join(', or ')}?`,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------------------------------------

function askerOf(item: AgendaItem, byId: ReadonlyMap<string, SessionView>): string {
  if (item.raisedBy === 'human') return 'you';
  if (item.raisedBy === 'daemon') return 'Ferretry';
  const session = byId.get(item.raisedBySession);
  return session === undefined ? (item.raisedByName ?? 'a ferret') : callsignOf(session);
}

function optionsOf(item: AgendaItem): readonly string[] {
  return item.ask?.kind === 'multiple-choice' ? item.ask.options.map(option => option.label) : [];
}

/** One open item as a line a voice reads: id, who asks, title, the question, its options, and when only the app can answer it. */
function attentionLine(item: AgendaItem, byId: ReadonlyMap<string, SessionView>): string {
  const options = optionsOf(item);
  const choices = options.length === 0 ? '' : ` Options: ${options.join(', ')}.`;
  const appOnly = needsTheApp(item) ? ' Only the Ferretry app can answer this one.' : '';
  return `!${item.id} — from ${askerOf(item, byId)} — ${clip(oneLine(item.title ?? item.subject), 80)} — ${clip(oneLine(item.why), 240)}${choices}${appOnly}`;
}

/** "A12", "!A12", "a 12", "12" → "A12"; undefined when it is none of those. */
export function parseAttentionRef(raw: string): string | undefined {
  const match = /^\s*!?\s*a?\s*0*([1-9][0-9]{0,8})\s*$/iu.exec(raw);
  return match === null ? undefined : `A${match[1]}`;
}

type AnswerShape =
  | { readonly kind: 'response'; readonly response: AgendaResponse }
  | { readonly kind: 'done' }
  | { readonly kind: 'refuse'; readonly sentence: string; readonly refused: boolean };

const YES = ['yes', 'yep', 'yeah', 'ok', 'okay', 'approve', 'approved', 'allow', 'allowed', 'good', 'sure'];
const NO = ['no', 'nope', 'reject', 'rejected', 'deny', 'denied', 'refuse'];
const bare = (text: string): string => text.toLowerCase().replace(/[^a-z]/gu, '');

/** The card kinds a spoken answer may close: a plain question, a choice, a yes/no, a review, a to-do, a note. */
const PLAIN_KINDS: readonly (AgendaKind | undefined)[] = [
  undefined,
  'task',
  'yesno',
  'permission',
  'choice',
  'review',
  'reply',
  'info',
];

/**
 * What makes an item an act only the OWNER does in the app, whatever its ask says: a held configuration change
 * (`confirms`), a card's gate or ask (`gate`, `gateAttached`, `cardAsks`), a task plan, a paste plan, a phone
 * approval, a 2FA seed, a sign-in rule, a form (`fields`), a typed value (`input`), a machine notice's cards.
 * Each of those is approved with a passkey or its own form, and a voice answer must never stand in for it.
 *
 * The primary defence is the daemon's boundary, which refuses these when the caller arrives governed; this is
 * the second, so the connector would not even TRY, and so it never reads like it could.
 */
const OWNER_ONLY_FIELDS = [
  'confirms',
  'gate',
  'gateAttached',
  'cardAsks',
  'input',
  'copyPlan',
  'taskPlan',
  'phoneApproval',
  'twoFactorSeed',
  'signInRuleSuggestion',
  'signInRuleSuspended',
  'cards',
  'fields',
] as const satisfies readonly (keyof AgendaItem)[];

const OWNER_ONLY_SENTENCE = 'That one needs your passkey in the Ferretry app.';

/**
 * True for any item a spoken answer may not close. An ALLOW-list of plain asks, not a list of bad ones: an item
 * is answerable only when its kind is one of {@link PLAIN_KINDS} AND it carries none of the owner-only fields,
 * so a kind or field added later is refused until someone decides a voice may answer it.
 */
function needsTheApp(item: AgendaItem): boolean {
  if (!PLAIN_KINDS.includes(item.kind)) return true;
  return OWNER_ONLY_FIELDS.some(field => item[field] !== undefined);
}

/** How a spoken answer becomes the response this item's ask accepts — or why it cannot. Pure. */
export function shapeAnswer(item: AgendaItem, answer: string): AnswerShape {
  if (item.kind === 'input')
    return {
      kind: 'refuse',
      sentence: 'That one asks for a value that can only be typed in the Ferretry app.',
      refused: true,
    };
  if (needsTheApp(item)) return { kind: 'refuse', sentence: OWNER_ONLY_SENTENCE, refused: true };
  const ask = item.ask;
  if (ask === undefined || ask.kind === 'task') return { kind: 'done' };
  switch (ask.kind) {
    case 'open-question':
      return { kind: 'response', response: { kind: 'open-question', answer } };
    case 'permission': {
      const word = bare(answer);
      if (YES.includes(word)) return { kind: 'response', response: { kind: 'permission', decision: 'approve' } };
      if (NO.includes(word)) return { kind: 'response', response: { kind: 'permission', decision: 'reject' } };
      return { kind: 'refuse', sentence: 'That is a permission request. Say approve or reject.', refused: false };
    }
    case 'answer-review': {
      if (YES.includes(bare(answer))) return { kind: 'response', response: { kind: 'answer-review', verdict: 'good' } };
      return { kind: 'response', response: { kind: 'answer-review', verdict: 'clarify', clarification: answer } };
    }
    case 'multiple-choice': {
      const labels = ask.options.map(option => option.label);
      const result = matchName(answer, labels, label => ({ exact: [label], names: [] }));
      if (result.kind === 'one')
        return { kind: 'response', response: { kind: 'multiple-choice', choice: result.item } };
      return { kind: 'refuse', sentence: `Pick one of these: ${labels.join(', ')}.`, refused: false };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------------------------

const ferretArg = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('Which ferret: its call sign (first name), task name or session id.');

const listFerrets: ConnectorToolSpec<Record<string, never>> = {
  name: 'list_ferrets',
  title: 'List ferrets',
  description:
    'List the ferrets (AI agents) running on this machine, one per line: call sign, task, state and how long ago it was last active. Use this first when the user asks what the ferrets are doing.',
  scope: 'fleet:read',
  annotations: READ,
  input: {},
  run: async (_args, env) => {
    const live = (await env.gateway.sessions()).filter(isLive);
    if (live.length === 0) return { text: 'No ferrets are running.' };
    const shown = live.slice(0, LIST_CAP);
    const lines = shown.map(
      view =>
        `${callsignOf(view)} — ${clip(oneLine(view.config.name), 80)} — ${stateOf(view)} — ${ago(env.now(), lastActivity(view))}`,
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
    'Describe one ferret: its state, current task or card, what it is doing right now, and its last error if it has one. Takes its call sign, task name or session id.',
  scope: 'fleet:read',
  annotations: READ,
  input: { ferret: ferretArg },
  run: async ({ ferret }, env) => {
    const view = await resolveFerret(env.gateway, ferret);
    const { state, config } = view;
    const lines = [
      `${callsignOf(view)}: ${clip(oneLine(config.name), 120)}.`,
      `State: ${stateOf(view)}. Last active ${ago(env.now(), lastActivity(view))}.`,
    ];
    if (config.focusTask !== undefined) lines.push(`Card: ${formatTaskRef(config.focusTask)}.`);
    if (state.activity !== undefined && state.activity.trim() !== '')
      lines.push(`Doing: ${clip(oneLine(state.activity), 200)}.`);
    if (state.needsHuman !== undefined && state.needsHuman.trim() !== '')
      lines.push(`Needs a person: ${clip(oneLine(state.needsHuman), 200)}.`);
    if (state.contextPercent !== undefined) lines.push(`Context ${Math.round(state.contextPercent)} percent full.`);
    const failed = ['failed', 'stalled', 'kill_failed', 'rate_limited'].includes(state.status);
    if (failed || state.exitCode !== undefined) {
      const why = state.reason ?? state.quota?.limitNotice;
      lines.push(`Last problem: ${why === undefined ? state.status : clip(oneLine(why), 200)}.`);
    }
    return { text: lines.join('\n'), sessionId: config.id };
  },
};

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
      .max(OUTPUT_MAX_LINES)
      .optional()
      .describe(`How many lines, default ${OUTPUT_DEFAULT_LINES}.`),
  },
  run: async ({ ferret, lines }, env) => {
    const view = await resolveFerret(env.gateway, ferret);
    const wanted = lines ?? OUTPUT_DEFAULT_LINES;
    // Cleaned BEFORE the tail is taken, so a credential is never cut in half and left half-visible.
    const text = await env.clean(await env.gateway.logs(view.config.id));
    const tail = tailText(text, wanted, OUTPUT_MAX_CHARS);
    if (tail.linesShown === 0) return { text: `${callsignOf(view)} has no output yet.`, sessionId: view.config.id };
    const note = tail.truncated ? ` Older output was cut; this is the last ${tail.linesShown} lines.` : '';
    return { text: `${callsignOf(view)} recent output:${note}\n${tail.text}`, sessionId: view.config.id };
  },
};

const listAttention: ConnectorToolSpec<Record<string, never>> = {
  name: 'list_attention',
  title: 'List open questions',
  description:
    'List the open agenda items, the questions and approvals ferrets are waiting on the owner for: id (like A12), who asks, title and the question. Use before answering one.',
  scope: 'fleet:read',
  annotations: READ,
  input: {},
  run: async (_args, env) => {
    const [items, sessions] = await Promise.all([env.gateway.openAgenda(), env.gateway.sessions()]);
    const byId = new Map(sessions.map(view => [view.config.id, view]));
    const open = items.filter(({ item }) => item.parked === undefined && item.kind !== 'input');
    if (open.length === 0) return { text: 'Nothing is waiting on you.' };
    const shown = open.slice(0, ATTENTION_CAP);
    const lines = shown.map(({ item }) => attentionLine(item, byId));
    const more = open.length > shown.length ? [`…and ${open.length - shown.length} more.`] : [];
    return { text: [`${open.length} waiting on you:`, ...lines, ...more].join('\n') };
  },
};

const sendToFerret: ConnectorToolSpec<{ ferret: typeof ferretArg; message: z.ZodString }> = {
  name: 'send_to_ferret',
  title: 'Send a message to a ferret',
  description:
    'Send a message to one ferret, as if the owner typed it in the Ferretry app. Use for instructions or replies in the conversation. To answer an open question or approval, use answer_attention instead.',
  scope: 'fleet:write',
  annotations: WRITE,
  input: { ferret: ferretArg, message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).describe('The message text.') },
  run: async ({ ferret, message }, env) => {
    const view = await resolveFerret(env.gateway, ferret, 'act');
    const result = await env.gateway.send(view.config.id, message);
    const who = callsignOf(view);
    const said: Record<string, string> = {
      delivered: `Sent to ${who}.`,
      sent: `Sent to ${who}; it is busy, so it will read it shortly.`,
      queued: `Queued for ${who}; it will read it when it is next free.`,
      revived: `${who} was stopped. I woke it up and sent your message.`,
      'queued-for-revive': `${who} was stopped. Your message is queued and it will wake up for it.`,
    };
    return { text: said[result.disposition] ?? `Sent to ${who}.`, sessionId: view.config.id };
  },
};

const answerAttention: ConnectorToolSpec<{
  item: z.ZodString;
  answer: z.ZodString;
  ferret: z.ZodOptional<z.ZodString>;
}> = {
  name: 'answer_attention',
  title: 'Answer an open question',
  description:
    'Answer one open agenda item (a question or approval a ferret is waiting on). Give the item id like A12 (list_attention shows them) and the answer in words: for a choice, the option; for an approval, approve or reject; otherwise the text.',
  scope: 'fleet:write',
  annotations: WRITE,
  input: {
    item: z.string().trim().min(1).max(20).describe('The item id, like A12.'),
    answer: z.string().trim().min(1).max(MESSAGE_MAX_CHARS).describe('The answer.'),
    ferret: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Only when two ferrets have an item with the same id: which one asked.'),
  },
  run: async ({ item, answer, ferret }, env) => {
    const id = parseAttentionRef(item);
    if (id === undefined) throw new ToolFailure(`"${oneLine(item)}" is not an item id. Ids look like A12.`);
    const [items, sessions] = await Promise.all([env.gateway.openAgenda(), env.gateway.sessions()]);
    const byId = new Map(sessions.map(view => [view.config.id, view]));
    let found = items.filter(entry => entry.item.id === id && entry.item.parked === undefined);
    if (ferret !== undefined) {
      // A ferret the caller NAMES is always honoured: when it has no such item the answer is a refusal, never
      // another ferret's item that happens to carry the same id.
      const wanted = await resolveFerret(env.gateway, ferret, 'act');
      found = found.filter(
        entry =>
          entry.sessionId === wanted.config.id ||
          (entry.item.raisedBy === 'agent' && entry.item.raisedBySession === wanted.config.id),
      );
      if (found.length === 0) throw new ToolFailure(`${callsignOf(wanted)} has no open item ${id}.`);
    }
    if (found.length === 0) throw new ToolFailure(`There is no open item ${id}. Ask me to list what is waiting.`);
    if (found.length > 1) {
      const askers = found.map(entry => askerOf(entry.item, byId)).join(' and ');
      throw new ToolFailure(`Item ${id} is open for more than one ferret (${askers}). Which ferret asked?`);
    }
    const target = found[0] as (typeof found)[number];
    const shaped = shapeAnswer(target.item, answer);
    if (shaped.kind === 'refuse')
      throw new ToolFailure(shaped.sentence, { refused: shaped.refused, sessionId: target.sessionId });
    const response = shaped.kind === 'response' ? shaped.response : undefined;
    try {
      await env.gateway.resolveAgenda(
        target.sessionId,
        id,
        target.item.askVersion ?? 1,
        response,
        shaped.kind === 'done' ? answer : undefined,
      );
    } catch (error) {
      if (error instanceof ToolFailure && error.code === 'ask_changed') throw await changedAsk(env, target, id, byId);
      throw error instanceof ToolFailure ? error.aimedAt(target.sessionId) : error;
    }
    return { text: `Answered ${id} from ${askerOf(target.item, byId)}.`, sessionId: target.sessionId };
  },
};

/**
 * The ferret replaced the ask between the moment the answer was shaped and the moment it landed. Nothing was
 * applied; say what the item asks NOW so the owner can answer the question they have not yet heard.
 */
async function changedAsk(
  env: ToolEnvironment,
  target: OpenAgendaItem,
  id: string,
  byId: ReadonlyMap<string, SessionView>,
): Promise<ToolFailure> {
  const now = (await env.gateway.openAgenda()).find(
    entry => entry.sessionId === target.sessionId && entry.item.id === id && entry.item.parked === undefined,
  );
  const sessionId = target.sessionId;
  if (now === undefined)
    return new ToolFailure(`That question changed and ${id} is not open any more. Nothing was sent.`, { sessionId });
  return new ToolFailure(
    `That question changed, so nothing was sent; here it is now: ${attentionLine(now.item, byId)}`,
    { sessionId },
  );
}

const restartFerret: ConnectorToolSpec<{ ferret: typeof ferretArg }> = {
  name: 'restart_ferret',
  title: 'Restart a ferret',
  description:
    'Restart one ferret on its current conversation, as the Restart button does. If it is busy mid-turn the restart waits until it is idle. Interrupts work in progress.',
  scope: 'fleet:write',
  annotations: DESTRUCTIVE,
  input: { ferret: ferretArg },
  run: async ({ ferret }, env) => {
    const view = await resolveFerret(env.gateway, ferret, 'act');
    const result = await env.gateway.restart(view.config.id);
    const who = callsignOf(view);
    if (result.restarted.length > 0) return { text: `Restarted ${who}.`, sessionId: view.config.id };
    if (result.queued.length > 0)
      return { text: `${who} is busy, so I queued the restart for when it is idle.`, sessionId: view.config.id };
    const failure = result.failed[0];
    if (failure !== undefined)
      throw new ToolFailure(`I could not restart ${who}: ${clip(oneLine(failure.reason), 200)}`);
    const skipped = result.skipped[0];
    return {
      text: `I left ${who} alone${skipped === undefined ? '' : ` (${skipped.reason.replace(/-/gu, ' ')})`}.`,
      sessionId: view.config.id,
    };
  },
};

const stopFerret: ConnectorToolSpec<{ ferret: typeof ferretArg }> = {
  name: 'stop_ferret',
  title: 'Stop a ferret',
  description:
    'Stop one ferret. It ends its session; it can be resumed later from the app. Use only when the user clearly asks to stop it.',
  scope: 'fleet:write',
  annotations: { ...DESTRUCTIVE, idempotentHint: true },
  input: { ferret: ferretArg },
  run: async ({ ferret }, env) => {
    const view = await resolveFerret(env.gateway, ferret, 'act');
    const who = callsignOf(view);
    if (!isLive(view)) return { text: `${who} is already ${view.state.status}.`, sessionId: view.config.id };
    await env.gateway.stop(view.config.id);
    return { text: `Stopped ${who}.`, sessionId: view.config.id };
  },
};

const spawnFerret: ConnectorToolSpec<{
  task: z.ZodString;
  name: z.ZodOptional<z.ZodString>;
  project: z.ZodOptional<z.ZodString>;
}> = {
  name: 'spawn_ferret',
  title: 'Start a new ferret',
  description:
    'Start a new ferret on a task, as the New ferret button does. Give the task in plain words, optionally a short name, and the project (one of the registered projects; list_ferrets does not show them, so if unsure leave it out and the error lists them).',
  scope: 'fleet:write',
  annotations: WRITE,
  input: {
    task: z.string().trim().min(1).max(4000).describe('What the new ferret should do.'),
    name: z.string().trim().min(1).max(100).optional().describe('A short task name.'),
    project: z.string().trim().min(1).max(200).optional().describe('A registered project name.'),
  },
  run: async ({ task, name, project }, env) => {
    const projects = await env.gateway.projects();
    const label = (entry: (typeof projects)[number]): string => entry.name;
    let chosen = projects.length === 1 ? projects[0] : undefined;
    if (project !== undefined) {
      const result = matchName(project, projects, entry => ({ exact: [entry.id], names: [entry.name] }));
      if (result.kind === 'one') chosen = result.item;
      else if (result.kind === 'many')
        throw new ToolFailure(
          `More than one project matches "${oneLine(project)}": ${result.items.map(label).join(', ')}. Which one?`,
        );
      else {
        const hint = result.suggestions.length > 0 ? result.suggestions : projects.slice(0, 8);
        throw new ToolFailure(
          `No project called "${oneLine(project)}". Projects: ${hint.map(label).join(', ') || 'none registered'}.`,
        );
      }
    }
    if (chosen === undefined) {
      if (projects.length === 0)
        throw new ToolFailure('No projects are registered on this machine, so I cannot start a ferret.');
      throw new ToolFailure(`Which project? Choose one of: ${projects.slice(0, 12).map(label).join(', ')}.`);
    }
    const view = await env.gateway.start(task, name, chosen.path);
    return {
      text: `Started ${callsignOf(view)} on "${clip(oneLine(task), 80)}" in ${chosen.name}.`,
      sessionId: view.config.id,
    };
  },
};

export const CONNECTOR_TOOLS: readonly ConnectorToolSpec[] = [
  listFerrets,
  getFerret,
  getFerretOutput,
  listAttention,
  sendToFerret,
  answerAttention,
  restartFerret,
  stopFerret,
  spawnFerret,
] as unknown as readonly ConnectorToolSpec[];

// ---------------------------------------------------------------------------------------------------------
// Running a tool
// ---------------------------------------------------------------------------------------------------------

export interface ToolboxOptions {
  readonly daemonGrants: DaemonGrantsSource;
  readonly guard: ConnectorTextGuard;
  readonly callsLog: ConnectorCallsLog;
  readonly audit: ConnectorAuditSink;
  readonly now: () => number;
}

/** What the SDK adapter gets back for one call. */
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * Everything around a tool body that is the same for all nine: the operator's grants, the token's scope,
 * redaction of what goes out, and the record of what a write did. The order is deliberate — nothing touches the
 * daemon before both gates have passed, and nothing leaves before it has been cleaned.
 */
export class ConnectorToolbox {
  constructor(private readonly options: ToolboxOptions) {}

  async execute(
    spec: ConnectorToolSpec,
    rawArgs: unknown,
    access: ConnectorAccess,
    gateway: FleetGateway,
  ): Promise<ToolResult> {
    const write = spec.scope === 'fleet:write';
    // `gated`: refused BEFORE the tool ran (scope, the operator's grants). The calls log keeps those; the security
    // log does not, because nothing was attempted. Every outcome of a tool that DID run is in both, as it ended.
    const finish = async (output: ToolOutput, outcome: ConnectorToolOutcome, gated = false): Promise<ToolResult> => {
      const text = await this.options.guard.clean(output.text);
      if (write) await this.record(spec, rawArgs, access, outcome, output.sessionId, gated);
      return { text, isError: outcome !== 'ok' };
    };
    if (!access.scopes.includes(spec.scope)) {
      return await finish(
        {
          text: 'This connection can only look, not change anything. It was approved for read access only.',
          isError: true,
        },
        'refused',
        true,
      );
    }
    let grants: ReturnType<DaemonGrantsSource>;
    try {
      grants = this.options.daemonGrants();
    } catch {
      grants = undefined;
    }
    const refusal = daemonGrantRefusal(spec.name, grants);
    if (refusal !== undefined) return await finish({ text: refusal, isError: true }, 'refused', true);
    try {
      const args = z.object(spec.input as z.ZodRawShape).parse(rawArgs ?? {});
      const output = await (spec.run as (a: unknown, e: ToolEnvironment) => Promise<ToolOutput>)(args, {
        gateway,
        now: this.options.now,
        clean: async text => await this.options.guard.clean(text),
      });
      return await finish(output, 'ok');
    } catch (error) {
      if (error instanceof ToolFailure)
        return await finish(
          {
            text: error.message,
            isError: true,
            ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
          },
          error.refused ? 'refused' : 'error',
        );
      return await finish(
        { text: 'Something went wrong on the machine, so I did not do that.', isError: true },
        'error',
      );
    }
  }

  private async record(
    spec: ConnectorToolSpec,
    rawArgs: unknown,
    access: ConnectorAccess,
    outcome: ConnectorToolOutcome,
    sessionId: string | undefined,
    gated: boolean,
  ): Promise<void> {
    try {
      const args = cutLongStrings(await this.options.guard.cleanData(rawArgs));
      await this.options.callsLog.append({
        at: new Date(this.options.now()).toISOString(),
        tool: spec.name,
        grantId: access.grantId,
        tokenId: access.tokenId,
        args: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
        outcome,
      });
    } catch {
      // The security log below still has the call; a calls-log failure must not fail the tool.
    }
    if (gated) return;
    try {
      await this.options.audit.record({
        kind: 'connector.tool',
        grantId: access.grantId,
        tool: spec.name,
        ...(sessionId === undefined ? {} : { sessionId }),
        outcome,
      });
    } catch {
      // The sink never throws into a request by contract; belt and braces.
    }
  }
}

/** Message/answer/task text is cut to 500 characters in the calls log: the log says WHAT was done, not the whole text. */
function cutLongStrings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? clip(entry, LOG_ARG_CUT) : entry]),
  );
}

export { WITHHELD };
