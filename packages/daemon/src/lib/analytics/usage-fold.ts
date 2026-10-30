import { type AnalyticsModelAliasGroup, normalizeAnalyticsModelIdentity } from '@ferretry/protocol';
import { isOwnerMessage } from '../transcript/owner.ts';
import type { TranscriptEvent, TranscriptHarness, TranscriptIssueCode } from '../transcript/types.ts';
import type { AnalyticsTokenUsage } from './pricing.ts';

/** A session's token total, as this daemon can prove it from that session's own transcript. */
export type AnalyticsSessionUsage = Omit<AnalyticsTokenUsage, 'createdAt'>;

/**
 * Why a session has no reportable token total.
 *
 * Every member is a REFUSAL, not a zero. A session whose evidence could not be read has spent an
 * unknown amount, and reporting that as no tokens and no cost would put a free run on the board.
 */
export type AnalyticsUsageRefusal =
  /** No transcript is attributable to this session, so there is nothing to count. */
  | 'transcript_unresolved'
  /** The transcript is this session's, but the daemon could not read or parse it. */
  | 'transcript_unreadable'
  /** Bytes were lost, truncated or unparseable, so no total can be claimed complete. */
  | 'transcript_damaged'
  /** The read ended mid-record, so the last usage figure may be missing or partial. */
  | 'transcript_incomplete'
  /** The transcript parsed cleanly and records no usage at all. */
  | 'no_usage_evidence'
  /** A usage figure whose accounting this daemon cannot state, so no total is derivable. */
  | 'ambiguous_token_accounting';

export type AnalyticsSessionUsageFold =
  | { readonly kind: 'usage'; readonly usage: AnalyticsSessionUsage }
  | { readonly kind: 'refused'; readonly reason: AnalyticsUsageRefusal };

/**
 * The transcript read this fold is derived from, including how it ended.
 *
 * Resolution failures are carried as their own states rather than as an empty event list, because
 * "this session's transcript could not be found" and "this session used no tokens" are different
 * claims and only one of them is ever true here.
 */
export type AnalyticsTranscriptEvidence =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'read';
      readonly harness: TranscriptHarness;
      readonly events: readonly TranscriptEvent[];
      readonly issues: readonly TranscriptIssueCode[];
      /** Bytes held back at the end of the read for want of a terminating newline. */
      readonly pendingBytes: number;
    };

/**
 * Where one finished session's own transcript evidence comes from.
 *
 * Keyed by session id and asked per session, so one daemon's analytics can only ever be assembled
 * from transcripts that same daemon resolved as belonging to its own sessions.
 */
export interface AnalyticsTranscriptEvidenceSource {
  evidenceFor(sessionId: string, harness: TranscriptHarness): Promise<AnalyticsTranscriptEvidence>;
}

/**
 * Issue codes that mean transcript bytes were never inspected.
 *
 * The distinction that matters is whether a record was SEEN. A record whose JSON parsed and which
 * the parser then modelled partially — an unsupported record type, a malformed tool input — was
 * inspected, and the parser can state that it carried no usage figure. A record whose bytes never
 * parsed, or which the read stopped short of, was never inspected at all, so a total computed
 * without it is a total nobody can call complete.
 */
const EVIDENCE_LOSING_ISSUES: readonly TranscriptIssueCode[] = [
  'invalid-json',
  'incomplete-line',
  'truncated-json',
  'oversized-record',
  'source-missing',
  'source-read-failed',
  'source-truncated',
  'window-capped',
];

interface UsageTotals {
  input: number;
  output: number;
  cachedRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning: number;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cachedRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 };
}

/**
 * The GROSS input a request billed, from a harness that does not report it that way.
 *
 * The two harnesses disagree about what `input_tokens` counts, and the disagreement is worth real
 * money. Anthropic reports uncached input only, with cache reads and cache writes as separate
 * figures beside it; OpenAI reports a prompt total with the cached portion named as a subset of it.
 * Both parsers already encode this in their own context-token derivation. Downstream pricing takes
 * a gross input and subtracts the cached parts back out, so each harness is converted to gross
 * exactly once, here.
 */
function grossInput(harness: TranscriptHarness, input: number, cachedRead: number, cacheWrite: number): number {
  return harness === 'claude' ? input + cachedRead + cacheWrite : input;
}

/**
 * Whether a harness's cache-write figure can be placed within its input accounting.
 *
 * Codex reports a prompt total that already contains its cached portion, but gives no basis for
 * saying whether a cache WRITE is inside that total or beside it. The two readings differ by the
 * write itself, so a figure this daemon cannot place is refused rather than assigned to whichever
 * side makes the arithmetic close.
 */
function cacheWriteIsPlaceable(harness: TranscriptHarness, cacheWrite: number): boolean {
  return harness === 'claude' || cacheWrite === 0;
}

/**
 * Whether a harness's reasoning tokens are a SEPARATELY BILLED part of its output.
 *
 * Codex reports `reasoning_output_tokens` as a named subset of the output total, and a provider may
 * charge that subset at its own rate — so it has to be visible to pricing rather than summed away.
 * Claude does not: extended thinking is billed as ordinary output tokens and no transcript figure
 * distinguishes it, so calling any part of a Claude session's output "reasoning" would invent a
 * distinction the provider never made and hand pricing a second rate to apply to it.
 *
 * NAMED POSITIVELY, one harness at a time. `!== 'claude'` would enrol every harness added later into
 * Codex's billing semantics by default, silently, on the strength of not being Anthropic's — and the
 * first anyone would learn of it is a bill. A harness earns this by being listed.
 */
function reasoningIsBilledApart(harness: TranscriptHarness): boolean {
  return harness === 'codex';
}

/**
 * The index of the usage record that speaks for each Claude message.
 *
 * Claude Code writes ONE LINE PER CONTENT BLOCK — thinking, text, each tool call — and every line
 * repeats its message's `message.id` and full `usage`. Summing them charged one API response two or
 * three times. A message id names exactly one API response, so it is the key; the LAST line wins
 * because it is the one written after the response finished, when the output figure is final.
 * Only Claude is keyed by message. Codex repeats differently — see `repeatsTheLastTotal`.
 */
function lastUsagePerMessage(events: readonly TranscriptEvent[]): ReadonlyMap<string, number> {
  const last = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.kind === 'usage' && event.harness === 'claude' && event.messageId !== undefined) {
      last.set(event.messageId, index);
    }
  });
  return last;
}

/**
 * Whether a usage record restates the request before it rather than reporting a new one.
 *
 * Codex sometimes writes a `token_count` again with the SAME session running total and the previous
 * request's per-request figures still attached; summing it charged that request twice (+1.4% input on
 * a real rollout against Codex's own total). A running total that did not move is no new request.
 */
function repeatsTheLastTotal(total: number | undefined, previous: number | undefined): boolean {
  return total !== undefined && total === previous;
}

function isCountable(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fold every usage record in one finished session's transcript into a single billable total.
 *
 * Summing across records is the correct accounting rather than taking the last one: each request a
 * harness makes bills its own full input, so a conversation's cost is the sum of its turns and not
 * the size of its final turn.
 *
 * The MODEL is transcript evidence only. Where a session ran under more than one model the total is
 * still reported — a token count does not depend on which model produced it — but no single pricing
 * model is claimed, so the cost comes back unpriced instead of charging one model's whole run at
 * another model's rate.
 *
 * WHY THE CATALOG'S ALIASES REACH THIS FAR. "More than one model" is a question about identity, and
 * only the operator's catalog knows that two spellings name one model. Deciding it here without the
 * alias groups made a session addressed by both spellings look like a mixed-model run and come back
 * unpriced — a false refusal, and one no downstream step could undo, because by then the second
 * spelling had already been thrown away.
 */
export function foldAnalyticsSessionUsage(
  evidence: AnalyticsTranscriptEvidence,
  aliasGroups: readonly AnalyticsModelAliasGroup[] = [],
): AnalyticsSessionUsageFold {
  if (evidence.kind === 'unresolved') return { kind: 'refused', reason: 'transcript_unresolved' };
  if (evidence.kind === 'unreadable') return { kind: 'refused', reason: 'transcript_unreadable' };
  if (evidence.issues.some(code => EVIDENCE_LOSING_ISSUES.includes(code))) {
    return { kind: 'refused', reason: 'transcript_damaged' };
  }
  if (evidence.pendingBytes > 0) return { kind: 'refused', reason: 'transcript_incomplete' };

  const totals = emptyTotals();
  const models = new Set<string>();
  let turnModel: string | undefined;
  let sawUsage = false;
  // Tracked apart from the total, because a harness that never states a reasoning figure and one that
  // states zero are different claims: the first cannot be reported as "this session did no reasoning".
  let sawReasoning = false;
  let sawMissingReasoning = false;

  const speaksForMessage = lastUsagePerMessage(evidence.events);
  let runningTotal: number | undefined;
  for (const [index, event] of evidence.events.entries()) {
    if (event.kind === 'settings') {
      // A turn-context record states the model the turn that FOLLOWS it ran under. Codex records
      // the model only here, so without it every Codex session would be unattributable.
      turnModel = event.settings.model ?? turnModel;
      continue;
    }
    if (event.kind !== 'usage') continue;
    if (
      event.harness === 'claude' &&
      event.messageId !== undefined &&
      speaksForMessage.get(event.messageId) !== index
    ) {
      continue;
    }

    const { usage } = event;
    if (repeatsTheLastTotal(usage.sessionTotalTokens, runningTotal)) continue;
    runningTotal = usage.sessionTotalTokens ?? runningTotal;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cachedRead = usage.cachedInputTokens ?? 0;
    const cacheWrite = usage.cacheCreationInputTokens ?? 0;
    const cacheWrite5m = usage.cacheWrite5mInputTokens ?? 0;
    const cacheWrite1h = usage.cacheWrite1hInputTokens ?? 0;
    const reasoning = usage.reasoningTokens ?? 0;
    // A negative or fractional token count is not a small error, it is a record this daemon does
    // not understand; one of them makes the whole session's total unstateable.
    if (![input, output, cachedRead, cacheWrite, cacheWrite5m, cacheWrite1h, reasoning].every(isCountable)) {
      return { kind: 'refused', reason: 'ambiguous_token_accounting' };
    }
    if (!cacheWriteIsPlaceable(evidence.harness, cacheWrite)) {
      return { kind: 'refused', reason: 'ambiguous_token_accounting' };
    }

    sawUsage = true;
    if (reasoningIsBilledApart(evidence.harness)) {
      if (usage.reasoningTokens === undefined) sawMissingReasoning = true;
      else {
        sawReasoning = true;
        totals.reasoning += reasoning;
      }
    }
    totals.input += grossInput(evidence.harness, input, cachedRead, cacheWrite);
    totals.output += output;
    totals.cachedRead += cachedRead;
    totals.cacheWrite += cacheWrite;
    totals.cacheWrite5m += cacheWrite5m;
    totals.cacheWrite1h += cacheWrite1h;

    const spelling = usage.model ?? turnModel;
    const identity = normalizeAnalyticsModelIdentity(spelling, aliasGroups);
    if (identity !== null) models.add(identity.modelId);
  }

  if (!sawUsage) return { kind: 'refused', reason: 'no_usage_evidence' };
  if (!Object.values(totals).every(value => Number.isSafeInteger(value))) {
    return { kind: 'refused', reason: 'ambiguous_token_accounting' };
  }

  // The split is reported only when the harness recorded one that accounts for the whole write.
  // A partial split priced as if it were complete would silently charge the remainder at nothing.
  const splitIsComplete = totals.cacheWrite5m + totals.cacheWrite1h === totals.cacheWrite;
  const [onlyModel] = models;

  return {
    kind: 'usage',
    usage: {
      pricingModel: models.size === 1 && onlyModel !== undefined ? onlyModel : null,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedInputTokens: totals.cachedRead,
      cacheWriteInputTokens: totals.cacheWrite,
      cacheWrite5mInputTokens: splitIsComplete ? totals.cacheWrite5m : null,
      cacheWrite1hInputTokens: splitIsComplete ? totals.cacheWrite1h : null,
      // Null where the transcript stated no reasoning figure at all, so pricing charges the whole
      // output at the output rate rather than being told a zero it would read as evidence.
      reasoningTokens: sawReasoning && !sawMissingReasoning ? totals.reasoning : null,
      // A partial total is not a total. Preserve the ordinary token evidence, but tell pricing to
      // refuse the cost rather than charge the known reasoning subset as though it were complete.
      ...(sawReasoning && sawMissingReasoning ? { reasoningTokensIncomplete: true } : {}),
    },
  };
}

/** How long a session was ACTIVE, and over how many turns, from its own transcript's timestamps. */
export interface AnalyticsSessionActivity {
  /** Σ over turns of (last record − prompt), in milliseconds, or `null` when it cannot be stated. */
  readonly activeDurationMs: number | null;
  /** Owner prompts in the transcript, or `null` when the transcript could not be read whole. */
  readonly turns: number | null;
}

const UNKNOWN_ACTIVITY: AnalyticsSessionActivity = { activeDurationMs: null, turns: null };

/**
 * Which transcript RECORD an event came from. One prompt record can normalise to several message events
 * — one per content block — and it is still one prompt. The record id where the harness states one, else
 * the line it was read from.
 */
function recordKey(event: TranscriptEvent): string | undefined {
  if (event.recordId !== undefined) return `id:${event.recordId}`;
  return event.line === undefined ? undefined : `line:${event.line}`;
}

/**
 * Context a harness writes into the USER channel as if the owner had said it, by the text it starts
 * with. Spellings are taken from real transcripts:
 *
 * - Codex opens every rollout with the workspace's instructions (`# AGENTS.md instructions` then
 *   `<INSTRUCTIONS>`, older builds `<user_instructions>`) and the environment (`<environment_context>`).
 * - Claude Code records a built-in command's local output (`<local-command-stdout>` /
 *   `<local-command-stderr>`) and an interrupt (`[Request interrupted by user`, with or without
 *   `for tool use]`) as user records. A slash command itself is decided apart: see `COMMAND_PREFIXES`.
 */
const INJECTED_PREFIXES: { readonly [H in TranscriptHarness]: readonly string[] } = {
  codex: ['# AGENTS.md instructions', '<INSTRUCTIONS>', '<user_instructions>', '<environment_context>'],
  claude: ['<local-command-stdout>', '<local-command-stderr>', '[Request interrupted by user'],
};

/**
 * How Claude Code records a slash command the owner typed. Whether it is a PROMPT depends on what it
 * does: a prompt-type command or skill (`/review`, `/kteam …`) expands into a prompt (an `isMeta`
 * record after it) and starts a turn like typed text; a built-in that runs locally (`/model`, `/clear`,
 * `/exit`) answers with `<local-command-stdout>` / `<local-command-stderr>` and asks the model nothing.
 */
const COMMAND_PREFIXES = ['<command-name>', '<command-message>', '<command-args>'];
const LOCAL_OUTPUT_PREFIXES = ['<local-command-stdout>', '<local-command-stderr>'];

const startsWithAny = (text: string, prefixes: readonly string[]): boolean => {
  const trimmed = text.trimStart();
  return prefixes.some(prefix => trimmed.startsWith(prefix));
};

/**
 * Where each user-channel RECORD begins, and which of them are local built-in commands.
 *
 * One record can normalise to several events — a text block, an image, another text block — and only
 * its first message event speaks for it; a record is identified by its key however many other events
 * sit between its blocks. A command record is local when the next user record is its local output.
 */
function userRecordStarts(events: readonly TranscriptEvent[]): {
  readonly firsts: ReadonlySet<number>;
  readonly localCommands: ReadonlySet<number>;
} {
  const starts: { readonly index: number; readonly text: string }[] = [];
  let current: string | undefined;
  events.forEach((event, index) => {
    if (event.kind !== 'message' || event.role !== 'user') return;
    const key = recordKey(event);
    if (key !== undefined && key === current) return;
    current = key;
    starts.push({ index, text: event.text });
  });
  const localCommands = new Set<number>();
  starts.forEach((start, position) => {
    const next = starts[position + 1];
    if (
      next !== undefined &&
      startsWithAny(start.text, COMMAND_PREFIXES) &&
      startsWithAny(next.text, LOCAL_OUTPUT_PREFIXES)
    ) {
      localCommands.add(start.index);
    }
  });
  return { firsts: new Set(starts.map(start => start.index)), localCommands };
}

/** How one event bears on active time. */
type ActivityRole =
  /** An owner prompt: closes the open turn and opens a new, counted one. */
  | 'prompt'
  /** User-channel input nobody typed as a prompt: closes the open turn, opens an uncounted segment. */
  | 'input'
  /** The harness or model doing something: extends whatever segment is open. */
  | 'work'
  /** The harness saying a turn is over: extends, then closes, the open segment. */
  | 'done'
  /** Bookkeeping — settings, turn starts, compaction, system context — which never moves a turn. */
  | 'none';

function activityRole(event: TranscriptEvent, localCommand: boolean): ActivityRole {
  if (event.kind === 'message' && event.role === 'user') {
    if (!isOwnerMessage(event) || localCommand) return 'input';
    return startsWithAny(event.text, INJECTED_PREFIXES[event.harness]) ? 'input' : 'prompt';
  }
  switch (event.kind) {
    case 'message':
      // A `<synthetic>` assistant record (claude.ts) is the harness talking, not the model working.
      return event.role === 'assistant' && event.inputSource !== 'harness' ? 'work' : 'none';
    case 'reasoning':
    case 'tool-call':
    case 'tool-result':
    case 'usage':
    case 'error':
      return 'work';
    case 'turn':
      return event.state === 'started' ? 'none' : 'done';
    default:
      return 'none';
  }
}

function eventInstant(event: TranscriptEvent): number | null {
  if (event.timestamp === undefined) return null;
  const parsed = Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fold one finished session's transcript into ACTIVE TIME and a turn count.
 *
 * A TURN starts at an owner prompt and runs to its last WORK record — an assistant message, reasoning,
 * a tool call or result, a usage or error record — before whatever ends it: the next prompt, input the
 * harness wrote into the user channel, the harness's own turn-complete record, or the end of the
 * transcript. Only work moves a turn's end. A settings record, a turn-started marker or a background
 * notification arriving hours later is not work, and letting it extend the turn counted the idle
 * time before it as active.
 *
 * Not every user-channel message is a prompt: a tool result is not a message at all; a record the
 * harness wrote itself (`isOwnerMessage` is false: a task notification, a compact summary) and the
 * context listed in `INJECTED_PREFIXES`, and a built-in command that ran locally, are INPUT; a
 * prompt-type slash command or skill IS a prompt. Input closes the open turn and opens an
 * UNCOUNTED segment — the work it provokes (a reply to a notification) is active time, but no turn. A
 * record whose first block is injected is injected as a whole: Codex sends its instructions and its
 * environment as two blocks of one message.
 *
 * A segment starts no earlier than the previous one ended, so records written slightly out of order
 * never count the same time twice. ACTIVE TIME is the sum of every segment.
 *
 * UNKNOWN, NOT ZERO, whenever the evidence cannot carry the claim: an unresolved, unreadable, damaged
 * or incomplete transcript, or a prompt with no readable timestamp, makes the whole session's active
 * time null — a partial sum would read as a short session. So does a transcript with NO prompt in it:
 * every session starts from one, so a transcript that shows none has a grammar this fold does not
 * recognise, and both figures are left to say nothing rather than claim an idle session.
 */
export function foldAnalyticsSessionActivity(evidence: AnalyticsTranscriptEvidence): AnalyticsSessionActivity {
  if (evidence.kind !== 'read') return UNKNOWN_ACTIVITY;
  if (evidence.pendingBytes > 0 || evidence.issues.some(code => EVIDENCE_LOSING_ISSUES.includes(code))) {
    return UNKNOWN_ACTIVITY;
  }

  let turns = 0;
  let active = 0;
  let timed = true;
  /** The open segment, or null between segments. */
  let open = null as { start: number; end: number } | null;
  /** Where the last segment ended: no later segment may start before it. */
  let floor = Number.NEGATIVE_INFINITY;
  const records = userRecordStarts(evidence.events);

  const close = () => {
    if (open === null) return;
    active += open.end - open.start;
    floor = open.end;
    open = null;
  };
  const begin = (at: number | null) => {
    close();
    open = at === null ? null : { start: Math.max(at, floor), end: Math.max(at, floor) };
  };

  for (const [index, event] of evidence.events.entries()) {
    const at = eventInstant(event);
    // A later block of a user record is that record's: one prompt, one injection.
    const continuing = event.kind === 'message' && event.role === 'user' && !records.firsts.has(index);
    const role = continuing ? 'none' : activityRole(event, records.localCommands.has(index));

    if (role === 'prompt') {
      turns += 1;
      if (at === null) timed = false;
      begin(at);
    } else if (role === 'input') {
      begin(at);
    } else if ((role === 'work' || role === 'done') && open !== null && at !== null && at > open.end) {
      open.end = at;
    }
    if (role === 'done') close();
  }
  close();
  if (turns === 0) return UNKNOWN_ACTIVITY;
  return { activeDurationMs: timed ? active : null, turns };
}

/** Everything ingestion keeps from one transcript: its token total (or refusal) and its activity. */
export interface AnalyticsTranscriptFold {
  readonly usage: AnalyticsSessionUsageFold;
  readonly activity: AnalyticsSessionActivity;
}

/**
 * Folds a transcript read into what ingestion stores — the ONE fold, whether it runs on the event loop
 * or in a worker thread, so where it runs can never change what it concludes.
 */
export function foldAnalyticsTranscript(
  evidence: AnalyticsTranscriptEvidence,
  aliasGroups: readonly AnalyticsModelAliasGroup[] = [],
): AnalyticsTranscriptFold {
  return { usage: foldAnalyticsSessionUsage(evidence, aliasGroups), activity: foldAnalyticsSessionActivity(evidence) };
}
