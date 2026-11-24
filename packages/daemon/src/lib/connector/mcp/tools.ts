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

import type { AgendaItem, AgendaResponse, SessionView } from '@ferretry/protocol';
import { formatTaskRef } from '@ferretry/protocol/board-refs';
import { z } from 'zod';
import type { ConnectorAccess, ConnectorAuditSink, ConnectorScope } from '../ports.ts';
import { type ConnectorToolName, daemonGrantRefusal } from './demands.ts';
import { ago, clip, oneLine, tailText } from './format.ts';
import { type FleetGateway, ToolFailure } from './gateway.ts';
import { matchName, titleVariants } from './names.ts';
import type { ConnectorCallsLog, DaemonGrantsSource } from './ports.ts';
import type { ConnectorTextGuard } from './redaction.ts';

const LIST_CAP = 50;
const ATTENTION_CAP = 30;
const OUTPUT_DEFAULT_LINES = 40;
const OUTPUT_MAX_LINES = 200;
const OUTPUT_MAX_CHARS = 8000;
const MESSAGE_MAX_CHARS = 8000;
const LOG_ARG_CUT = 500;

interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
}

/** What a tool says back: the sentence(s), and the session it touched (for the security log). */
interface ToolOutput {
  readonly text: string;
  readonly isError?: true;
  readonly sessionId?: string;
}

interface ToolEnvironment {
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
const callsignOf = (view: SessionView): string => titleCase(view.config.teammate ?? view.config.name);

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

/**
 * The one live ferret a spoken name means, or a {@link ToolFailure} that says what to try. Live ones are asked
 * first; a stopped one is found only when no live one matches (so "restart lizzette" can wake a stopped one).
 */
async function resolveFerret(gateway: FleetGateway, query: string): Promise<SessionView> {
  const all = await gateway.sessions();
  const live = all.filter(isLive);
  for (const pool of [live, all.filter(view => !isLive(view))]) {
    const result = matchName(query, pool, keysOfSession);
    if (result.kind === 'one') return result.item;
    if (result.kind === 'many') {
      const names = result.items.slice(0, 5).map(describeShort).join('; ');
      throw new ToolFailure(`More than one ferret matches "${oneLine(query)}": ${names}. Which one do you mean?`);
    }
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

/** "A12", "!A12", "a 12", "12" → "A12"; undefined when it is none of those. */
export function parseAttentionRef(raw: string): string | undefined {
  const match = /^\s*!?\s*a?\s*0*([1-9][0-9]{0,8})\s*$/iu.exec(raw);
  return match === null ? undefined : `A${match[1]}`;
}

type AnswerShape =
  | { readonly kind: 'response'; readonly response: AgendaResponse }
  | { readonly kind: 'done' }
  | { readonly kind: 'refuse'; readonly sentence: string };

const YES = ['yes', 'yep', 'yeah', 'ok', 'okay', 'approve', 'approved', 'allow', 'allowed', 'good', 'sure'];
const NO = ['no', 'nope', 'reject', 'rejected', 'deny', 'denied', 'refuse'];
const bare = (text: string): string => text.toLowerCase().replace(/[^a-z]/gu, '');

/** How a spoken answer becomes the response this item's ask accepts — or why it cannot. Pure. */
export function shapeAnswer(item: AgendaItem, answer: string): AnswerShape {
  if (item.kind === 'input')
    return { kind: 'refuse', sentence: 'That one asks for a value that can only be typed in the Ferretry app.' };
  if (item.gate !== undefined)
    return { kind: 'refuse', sentence: 'That one is a card review. Answer it in the Ferretry app.' };
  const ask = item.ask;
  if (ask === undefined || ask.kind === 'task') return { kind: 'done' };
  switch (ask.kind) {
    case 'open-question':
      return { kind: 'response', response: { kind: 'open-question', answer } };
    case 'permission': {
      const word = bare(answer);
      if (YES.includes(word)) return { kind: 'response', response: { kind: 'permission', decision: 'approve' } };
      if (NO.includes(word)) return { kind: 'response', response: { kind: 'permission', decision: 'reject' } };
      return { kind: 'refuse', sentence: 'That is a permission request. Say approve or reject.' };
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
      return { kind: 'refuse', sentence: `Pick one of these: ${labels.join(', ')}.` };
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
    const lines = shown.map(({ item }) => {
      const asker = askerOf(item, byId);
      const options = optionsOf(item);
      const choices = options.length === 0 ? '' : ` Options: ${options.join(', ')}.`;
      return `!${item.id} — from ${asker} — ${clip(oneLine(item.title ?? item.subject), 80)} — ${clip(oneLine(item.why), 240)}${choices}`;
    });
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
    const view = await resolveFerret(env.gateway, ferret);
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
    if (ferret !== undefined && found.length > 1) {
      const wanted = await resolveFerret(env.gateway, ferret);
      found = found.filter(entry => entry.sessionId === wanted.config.id);
    }
    if (found.length === 0) throw new ToolFailure(`There is no open item ${id}. Ask me to list what is waiting.`);
    if (found.length > 1) {
      const askers = found.map(entry => askerOf(entry.item, byId)).join(' and ');
      throw new ToolFailure(`Item ${id} is open for more than one ferret (${askers}). Which ferret asked?`);
    }
    const target = found[0] as (typeof found)[number];
    const shaped = shapeAnswer(target.item, answer);
    if (shaped.kind === 'refuse') throw new ToolFailure(shaped.sentence);
    const response = shaped.kind === 'response' ? shaped.response : undefined;
    await env.gateway.resolveAgenda(target.sessionId, id, response, shaped.kind === 'done' ? answer : undefined);
    return { text: `Answered ${id} from ${askerOf(target.item, byId)}.`, sessionId: target.sessionId };
  },
};

const restartFerret: ConnectorToolSpec<{ ferret: typeof ferretArg }> = {
  name: 'restart_ferret',
  title: 'Restart a ferret',
  description:
    'Restart one ferret on its current conversation, as the Restart button does. If it is busy mid-turn the restart waits until it is idle. Interrupts work in progress.',
  scope: 'fleet:write',
  annotations: DESTRUCTIVE,
  input: { ferret: ferretArg },
  run: async ({ ferret }, env) => {
    const view = await resolveFerret(env.gateway, ferret);
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
    const view = await resolveFerret(env.gateway, ferret);
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
    const finish = async (output: ToolOutput, outcome: 'ok' | 'error' | 'refused'): Promise<ToolResult> => {
      const text = await this.options.guard.clean(output.text);
      if (write) await this.record(spec, rawArgs, access, outcome, output.sessionId);
      return { text, isError: outcome !== 'ok' };
    };
    if (!access.scopes.includes(spec.scope)) {
      return await finish(
        {
          text: 'This connection can only look, not change anything. It was approved for read access only.',
          isError: true,
        },
        'refused',
      );
    }
    let grants: ReturnType<DaemonGrantsSource>;
    try {
      grants = this.options.daemonGrants();
    } catch {
      grants = undefined;
    }
    const refusal = daemonGrantRefusal(spec.name, grants);
    if (refusal !== undefined) return await finish({ text: refusal, isError: true }, 'refused');
    try {
      const args = z.object(spec.input as z.ZodRawShape).parse(rawArgs ?? {});
      const output = await (spec.run as (a: unknown, e: ToolEnvironment) => Promise<ToolOutput>)(args, {
        gateway,
        now: this.options.now,
        clean: async text => await this.options.guard.clean(text),
      });
      return await finish(output, 'ok');
    } catch (error) {
      if (error instanceof ToolFailure) return await finish({ text: error.message, isError: true }, 'error');
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
    outcome: 'ok' | 'error' | 'refused',
    sessionId: string | undefined,
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
    if (outcome === 'refused') return;
    try {
      await this.options.audit.record({
        kind: 'connector.tool',
        grantId: access.grantId,
        tool: spec.name,
        ...(sessionId === undefined ? {} : { sessionId }),
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
