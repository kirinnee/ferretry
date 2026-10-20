/**
 * Classify a `chat.user` record's text as a HARNESS-INJECTED SYSTEM BLOCK rather
 * than something a human (or a peer session) actually typed.
 *
 * WHY THIS EXISTS. Both harnesses smuggle machine text into the user channel —
 * it is the only channel the harness reads back. Task-completion notifications,
 * the Codex `<environment_context>` turn, the daemon's own `Read the file
 * …turn-NNN.md` prompt, interrupt notices and post-compaction summaries all
 * arrive as `chat.user` records and, without this, render as full-width fake
 * HUMAN messages (the right-aligned human bubble). The single biggest offender is
 * the turn prompt: in the kteam corpus this classifier was mined from, ~1,584
 * records across all sessions — one per turn, each drawn as a paragraph the human
 * never wrote.
 *
 * PURE, RENDER-TIME CLASSIFIER. It never mutates the record; `raw` always carries
 * the full original text so a row can reveal it verbatim behind a disclosure —
 * nothing is ever dropped. Classification is a UI concern today; the rule table
 * is deliberately written to lift-and-shift into the daemon later (emit
 * `system.*` record types at ingestion) with this left as the legacy fallback for
 * pre-migration history.
 *
 * DEGRADE DIRECTION IS DELIBERATE. Every rule is anchored/leading and the generic
 * fallback additionally requires a matching close tag, so the failure mode is a
 * false NEGATIVE — a system text shown as a user message, which is exactly the
 * unclassified status quo — never a false POSITIVE that demotes real human words
 * to a muted system row.
 *
 * Ported from kteam's `src/lib/system-blocks.ts`. The only behavioural change is
 * the turn-prompt path, which reads the protocol's own pointer format.
 */

import { parseHandoffPointer } from '@ferretry/protocol';

/** Chip tone derived from a notification status or an interrupt notice. */
export type SystemBlockTone = 'ok' | 'warn' | 'err';

export interface SystemBlockInfo {
  /** 'task notification' | 'system reminder' | 'turn prompt' | 'interrupted' |
   *  'context compacted' | the raw tag name for the generic fallback. */
  readonly label: string;
  /** The one human-useful line, already trimmed/collapsed for a single-line row. */
  readonly summary?: string;
  /** task-notification `<status>` verbatim (completed | stopped | killed | …). */
  readonly status?: string;
  /** Derived chip tone. Set from status, or directly for interrupt notices. */
  readonly tone?: SystemBlockTone;
  /** A context boundary gets full-width divider treatment while retaining the
   *  same collapsed disclosure contract as every other system row. */
  readonly divider?: 'compaction';
  /** Each background task a task notification reports, in order — one record can carry several. */
  readonly tasks?: readonly BackgroundTaskEvent[];
  /** ALWAYS the full original text, untouched — the disclosure body. */
  readonly raw: string;
}

/** What kind of background work Claude Code reported on. */
export type BackgroundTaskKind = 'command' | 'monitor' | 'agent' | 'task';

/** How it went: `event` is a monitor's line of output, which is neither an end nor a failure. */
export type BackgroundTaskOutcome = 'finished' | 'failed' | 'stopped' | 'event';

/**
 * ONE `<task-notification>`, read. Claude Code writes one when a `run_in_background` command, a
 * Monitor or a subagent finishes or reports, and its `<summary>` is a sentence in one of a few fixed
 * shapes (`Background command "…" completed (exit code 0)`, `Monitor event: "…"`, `Agent "…" finished`).
 * The sentence is taken apart so a row can say what ran and how it ended without repeating the command
 * twice; a summary in any other shape is kept whole as the subject, never dropped.
 */
export interface BackgroundTaskEvent {
  readonly kind: BackgroundTaskKind;
  readonly outcome: BackgroundTaskOutcome;
  /** The command line, the monitor's description, the agent's name — or an unrecognised summary. */
  readonly subject?: string;
  readonly exitCode?: number;
  /** Where Claude Code wrote the task's output, on the agent's machine. Shown as text, never a link. */
  readonly outputFile?: string;
  /** A subagent's `<result>`, a monitor's `<event>`, or why an agent failed. */
  readonly detail?: string;
  readonly tone?: SystemBlockTone;
}

/** ~160 chars is the point past which a one-line summary stops being scannable;
 *  the raw disclosure holds the rest. Newlines collapse to spaces so a
 *  multi-line element (a long `<summary>`) still renders as one row. */
function oneLine(value: string | undefined, max = 160): string | undefined {
  if (value == null) return undefined;
  const flat = value.replace(/\s+/gu, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Content between the FIRST `<tag>…</tag>` pair, trimmed. */
function tagContent(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(text);
  return match ? match[1]?.trim() : undefined;
}

function firstLine(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  return value
    .split('\n')
    .find(line => line.trim())
    ?.trim();
}

/** completed→ok, killed/failed→err, anything else non-empty→warn. */
function toneForStatus(status: string | undefined): SystemBlockTone | undefined {
  if (!status) return undefined;
  if (status === 'completed') return 'ok';
  if (status === 'killed' || status === 'failed') return 'err';
  return 'warn';
}

/** Claude Code escapes the text inside a notification's elements as XML; a row shows it as written. */
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (value: string): string =>
  value.replace(/&(amp|lt|gt|quot|apos);/gu, (_entity, name: string) => XML_ENTITIES[name] as string);

/** A decoded element, or `undefined` when it is absent or blank. */
function element(text: string, tag: string): string | undefined {
  const value = tagContent(text, tag);
  return value ? decodeEntities(value) : undefined;
}

// The fixed sentences Claude Code writes as a notification's `<summary>`. Each is anchored at both ends,
// so a sentence in a shape this does not know is shown whole rather than half-parsed. A subject is
// captured greedily because an agent's name or a command line can itself contain `"`.
const SUMMARY_SHAPES: readonly {
  readonly pattern: RegExp;
  readonly kind: BackgroundTaskKind;
  readonly outcome: BackgroundTaskOutcome;
}[] = [
  {
    pattern: /^Background command "([\s\S]*)" completed \(exit code (\d+)[^)]*\)$/u,
    kind: 'command',
    outcome: 'finished',
  },
  { pattern: /^Background command "([\s\S]*)" failed with exit code (\d+)$/u, kind: 'command', outcome: 'failed' },
  { pattern: /^Background command "([\s\S]*)" was stopped$/u, kind: 'command', outcome: 'stopped' },
  { pattern: /^Monitor event: "([\s\S]*)"$/u, kind: 'monitor', outcome: 'event' },
  { pattern: /^Monitor "([\s\S]*)" stream ended$/u, kind: 'monitor', outcome: 'finished' },
  { pattern: /^Monitor "([\s\S]*)" script failed \(exit (\d+)\)$/u, kind: 'monitor', outcome: 'failed' },
  { pattern: /^Monitor "([\s\S]*)" stopped$/u, kind: 'monitor', outcome: 'stopped' },
  { pattern: /^Agent "([\s\S]*)" finished$/u, kind: 'agent', outcome: 'finished' },
  { pattern: /^Agent "([\s\S]*)" was stopped by user$/u, kind: 'agent', outcome: 'stopped' },
];
const AGENT_FAILED = /^Agent "([\s\S]*?)" failed: ([\s\S]*)$/u;

/** A status with no sentence to read it from: `killed` is a stop, anything unknown is just an event. */
function outcomeForStatus(status: string | undefined): BackgroundTaskOutcome {
  if (status === 'completed') return 'finished';
  if (status === 'failed') return 'failed';
  if (status === 'killed' || status === 'stopped') return 'stopped';
  return 'event';
}

const TONE_FOR_OUTCOME: Readonly<Record<BackgroundTaskOutcome, SystemBlockTone | undefined>> = {
  finished: 'ok',
  failed: 'err',
  stopped: 'warn',
  event: undefined,
};

/** The trailing advice Claude Code appends inside a Monitor notification, which is addressed to the model. */
const MONITOR_ADVICE = /\n?If this event is something the user would act on now[\s\S]*$/u;

/** One `<task-notification>` block's body, read into a task event. */
function backgroundTask(block: string): BackgroundTaskEvent {
  const summary = element(block, 'summary');
  const outputFile = element(block, 'output-file');
  const status = tagContent(block, 'status');
  const failure = summary === undefined ? null : AGENT_FAILED.exec(summary);
  const shape = summary === undefined ? undefined : SUMMARY_SHAPES.find(candidate => candidate.pattern.test(summary));
  const match = shape === undefined || summary === undefined ? null : shape.pattern.exec(summary);
  const kind: BackgroundTaskKind = failure ? 'agent' : (shape?.kind ?? 'task');
  const outcome = failure ? 'failed' : (shape?.outcome ?? outcomeForStatus(status));
  const subject = failure ? failure[1] : match ? match[1] : summary;
  const exitCode = match?.[2] === undefined ? undefined : Number(match[2]);
  const detail = failure
    ? failure[2]
    : (element(block, 'result') ?? element(block, 'event')?.replace(MONITOR_ADVICE, ''));
  const tone = toneForStatus(status) ?? TONE_FOR_OUTCOME[outcome];
  return {
    kind,
    outcome,
    ...(subject ? { subject } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(outputFile ? { outputFile } : {}),
    ...(detail?.trim() ? { detail: detail.trim() } : {}),
    ...(tone ? { tone } : {}),
  };
}

const TASK_BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/gu;

/**
 * Claude Code's warning to the model that heads a notification it sends as a meta record — four lines
 * saying the text is not the user. It is the harness talking to the model, so it is no part of the row.
 */
const NOT_USER_INPUT = /^\s*\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*?(?=<task-notification>)/u;

/** The worst tone across several tasks: one failure among three finishes is still a failure. */
function worstTone(tasks: readonly BackgroundTaskEvent[]): SystemBlockTone | undefined {
  const tones = tasks.map(task => task.tone);
  if (tones.includes('err')) return 'err';
  if (tones.includes('warn')) return 'warn';
  return tones.includes('ok') ? 'ok' : undefined;
}

// A message another agent sent through Claude Code's own agent messaging — a subagent or teammate
// inside this session, or the coordinator that spawned it — which Claude Code types into the user
// channel with a fixed opener. It is a message, but never the owner's.
const AGENT_MESSAGE =
  /^Another Claude session sent a message(?: while you were working)?:\n<agent-message from="([^"]*)">\n?([\s\S]*?)\n?<\/agent-message>/u;
const COORDINATOR_MESSAGE = /^The coordinator sent a message(?: while you were working)?:\n([\s\S]+)$/u;

// The daemon's own turn prompt is the protocol's (`parseHandoffPointer`): one owner for the sentence the
// daemon types and every reader of it, matched only as the WHOLE message and on the path's invariant
// `…/turns/turn-NNN.md` tail, so it is home-, layout- and platform-agnostic and a human sentence that
// merely mentions a `.md` file cannot match.

// Harness interrupt notices. The raw IS the summary.
const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]/u;

// Post-compaction openers. Claude writes the first form as a user record; Codex
// writes the second inside its canonical top-level `compacted.payload.message`
// record (normalized to chat.user by the Codex transcript reader).
const COMPACTED =
  /^(?:This session is being continued from a previous conversation|Another language model started to solve this problem and produced a summary)/u;

// Daemon-injected automode/liveness plumbing. These are emitted by the daemon
// into the user channel to steer an autonomous session; each is anchored on the
// exact daemon-authored prefix so a human paraphrase cannot trip it.
// `CONTINUE_EXACT` is a WHOLE-STRING match — the most conservative possible —
// because the sentence is short enough that a leading-substring rule could
// plausibly demote a human message.
const LIVENESS = /^Liveness check: no output, pane change, or subprocess activity/u;
const AUTOMODE = /^Automode: do not wait for user input\./u;
const CONTINUE_EXACT = /^Continue from where you left off\.$/u;
// Daemon "declared wait elapsed" notice. The prefix and suffix are FIXED — only
// the parenthesized condition varies (the daemon substitutes `no condition given`
// when the wait carried none). Anchored on BOTH the fixed prefix and suffix,
// whole-string, so a human quoting the phrase cannot trip it; capture group 1 is
// the raw condition text.
const WAIT_ELAPSED =
  /^The wait you declared has elapsed \(([\s\S]*)\)\. Re-check the condition and continue the task\.\s*$/u;
// Image attachment metadata the harness prepends. Required to be the ENTIRE text
// (0/31 observed records carry trailing prose): if a future record appends the
// human's message after the bracket, it degrades to a user message — the safe
// direction — rather than hiding what the human wrote.
const IMAGE_META = /^\[Image: original (\d+x\d+)[^\]]*\]$/u;

// Claude Code's local slash-command markers. These had ZERO occurrences in the
// mined corpus (daemon-run sessions never take the local-command path), so the
// generic fallback below cannot see them: they arrive as INLINE
// (`<command-name>/foo</command-name>`) or SIBLING pairs, never as a lone opening
// line. They are handled with a narrow, explicit allow-list — the tag names are
// specific enough that a human sentence cannot trip it — while the generic
// fallback stays conservative.
const COMMAND_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
];

// The Codex protocol turn — `# AGENTS.md instructions` followed by the
// `<INSTRUCTIONS>` / `<environment_context>` wrapper. It is genuinely the
// harness's instructions turn, not human prose, yet without this it renders in
// the right-aligned user voice, misattributing machine plumbing to the human.
// Anchored on the exact header AND gated on the wrapper's presence so an ordinary
// `# …` markdown heading a human typed can never match.
const CODEX_PROTOCOL = /^#\s*AGENTS\.md instructions\b/u;

// Generic-fallback opener: the FIRST line is exactly one opening tag (optionally
// with attributes) and nothing else. `<tag>` or `<tag attr="…">`.
const LEADING_TAG = /^<([a-zA-Z][\w:-]*)(\s[^>]*)?>\s*$/u;

/** A summary section title carries structure but no useful content. Real Claude
 *  payloads use `1. **Primary Request and Intent:**`; real Codex payloads use
 *  Markdown headings such as `## Checkpoint`. */
function isCompactionHeading(line: string): boolean {
  const trimmed = line.trim();
  if (/^#{1,6}\s+\S/u.test(trimmed)) return true;
  const withoutListMarker = trimmed.replace(/^\d+[.)]\s+/u, '').replace(/^[-*]\s+/u, '');
  const withoutEmphasis = withoutListMarker.replace(/^\*{1,2}/u, '').replace(/\*{1,2}$/u, '');
  return withoutEmphasis.length <= 120 && /:\s*$/u.test(withoutEmphasis);
}

function compactionSummary(text: string): string | undefined {
  const lines = text.split('\n');
  const explicitHeader = lines.findIndex(line => /^\s*summary\s*:?\s*$/iu.test(line));
  // Claude has an explicit `Summary:` line. Codex's first line is boilerplate
  // ending in a colon, so start after that opener when no standalone header is
  // present.
  const start = explicitHeader >= 0 ? explicitHeader + 1 : 1;
  for (let index = start; index < lines.length; index += 1) {
    const candidate = lines[index]?.trim() ?? '';
    if (!candidate || isCompactionHeading(candidate)) continue;
    return candidate.replace(/^(?:\d+[.)]|[-*])\s+/u, '').trim() || undefined;
  }
  return undefined;
}

/**
 * Returns block info when `text` is harness-injected system noise, or `null` when
 * it should render as an ordinary user message. Rules are ordered; first match
 * wins.
 */
export function classifySystemText(text: string): SystemBlockInfo | null {
  if (!text) return null;

  // 1. task-notification — structured, with a status chip and a summary line.
  //    Both `<summary>` and the first `<result>` line are human-actionable, so
  //    both contribute to the compact line (result second, de-duplicated if it
  //    repeats the summary); the collapsed line may truncate, but the raw
  //    disclosure always retains the full text.
  //    A record may open with Claude Code's NOT-USER-INPUT warning and carry several notifications;
  //    each becomes one task, and the row's tone is the worst of them.
  const notifications = text.replace(NOT_USER_INPUT, '');
  if (/^\s*<task-notification>/u.test(notifications)) {
    const status = tagContent(notifications, 'status');
    const summaryElement = oneLine(element(notifications, 'summary'));
    const resultLine = oneLine(firstLine(element(notifications, 'result')));
    const parts = [summaryElement, resultLine === summaryElement ? undefined : resultLine].filter(Boolean);
    const summary = oneLine(parts.join(' · '));
    const tasks = [...notifications.matchAll(TASK_BLOCK)].map(block => backgroundTask(block[1] as string));
    const tone = tasks.length > 0 ? worstTone(tasks) : toneForStatus(status);
    return {
      label: 'task notification',
      raw: text,
      tasks,
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      ...(tone ? { tone } : {}),
    };
  }

  //    A message from another agent through Claude Code's own messaging, or from its coordinator.
  const agent = AGENT_MESSAGE.exec(text);
  if (agent) {
    const summary = oneLine(firstLine(agent[2]));
    return { label: 'agent message', raw: text, ...(summary ? { summary } : {}) };
  }
  const coordinator = COORDINATOR_MESSAGE.exec(text);
  if (coordinator) {
    const summary = oneLine(firstLine(coordinator[1]));
    return { label: 'coordinator message', raw: text, ...(summary ? { summary } : {}) };
  }

  // 2. system-reminder (rare in chat.user; the common ones live inside tool
  //    results and already render there).
  if (/^\s*<system-reminder>/u.test(text)) {
    const inner = oneLine(
      text
        .split('\n')
        .map(line => line.trim())
        .find(line => line && !line.startsWith('<')),
    );
    return { label: 'system reminder', raw: text, ...(inner ? { summary: inner } : {}) };
  }

  // 3. daemon turn prompt.
  const turn = parseHandoffPointer(text);
  if (turn?.kind === 'turn') return { label: 'turn prompt', summary: `${turn.name}.md`, raw: text };

  // 4. interrupt notice.
  if (INTERRUPTED.test(text)) {
    const summary = oneLine(firstLine(text));
    return { label: 'interrupted', tone: 'warn', raw: text, ...(summary ? { summary } : {}) };
  }

  // 5. compaction summary. Show the first useful line AFTER the `Summary`
  //    header/opener, never a Markdown or numbered section heading. Leading list
  //    markers are stripped so a `1.`/`-` bullet reads cleanly.
  if (COMPACTED.test(text)) {
    const summary = oneLine(compactionSummary(text)) ?? 'earlier conversation summarised';
    return { label: 'context compacted', divider: 'compaction', summary, raw: text };
  }

  // 6. daemon liveness nudge.
  if (LIVENESS.test(text)) return { label: 'liveness', summary: 'no recent activity — continuing', raw: text };

  // 7. daemon automode notice.
  if (AUTOMODE.test(text)) return { label: 'automode', summary: 'do not wait for input', raw: text };

  // 8. daemon "continue" nudge (whole-string match, see CONTINUE_EXACT).
  if (CONTINUE_EXACT.test(text.trim())) return { label: 'continue', summary: 'resume where left off', raw: text };

  // 9. daemon "declared wait elapsed" notice. Surface the parenthesized condition
  //    as the summary; fixed fallback when it carried none (empty or the daemon's
  //    own `no condition given` placeholder).
  const wait = WAIT_ELAPSED.exec(text.trim());
  if (wait) return { label: 'wait elapsed', summary: oneLine(wait[1]) ?? 'no condition given', raw: text };

  // 10. image-attachment metadata.
  const image = IMAGE_META.exec(text.trim());
  if (image) return { label: 'image', summary: `original ${image[1]}`, raw: text };

  // 11. Codex protocol turn (`# AGENTS.md instructions` + the harness wrapper).
  if (CODEX_PROTOCOL.test(text) && /<INSTRUCTIONS>|<environment_context>/u.test(text)) {
    return { label: 'agents instructions', summary: 'Codex harness instructions', raw: text };
  }

  // 12. Known local slash-command markers (see COMMAND_TAGS). The leading tag must
  //     be one of the known names AND close somewhere (inline or block) — the
  //     close is the same safety valve as rule 13.
  const firstNonEmpty = text
    .split('\n')
    .map(line => line.trim())
    .find(line => line);
  const lead = firstNonEmpty === undefined ? null : /^<([a-zA-Z][\w:-]*)\b/u.exec(firstNonEmpty);
  const commandTag = lead?.[1];
  if (commandTag && COMMAND_TAGS.includes(commandTag) && new RegExp(`</${commandTag}>`, 'u').test(text)) {
    // The slash-command name is the actionable bit; fall back to the message or
    // any command output when a bare stdout/stderr block arrives alone.
    const summary =
      oneLine(tagContent(text, 'command-name')) ??
      oneLine(tagContent(text, 'command-message')) ??
      oneLine(firstLine(tagContent(text, 'local-command-stdout'))) ??
      oneLine(firstLine(tagContent(text, 'local-command-stderr')));
    return { label: 'command', raw: text, ...(summary ? { summary } : {}) };
  }

  // 13. Generic fallback: a message whose FIRST line is a lone opening tag AND
  //     whose text contains the matching close tag. Both conditions required —
  //     the close tag is the safety valve keeping an unclosed `<…` human message a
  //     user message. Catches `<environment_context>` today and any future harness
  //     wrapper with no release.
  const head = LEADING_TAG.exec(text.split('\n', 1)[0] ?? '');
  const wrapperTag = head?.[1];
  if (wrapperTag && new RegExp(`</${wrapperTag}>`, 'u').test(text)) {
    const inner = oneLine(
      text
        .split('\n')
        .slice(1)
        .map(line => line.trim())
        .find(line => line && !line.startsWith('<')),
    );
    return { label: wrapperTag, raw: text, ...(inner ? { summary: inner } : {}) };
  }

  return null;
}

const TASK_NOUN: Readonly<Record<BackgroundTaskKind, string>> = {
  command: 'Background command',
  monitor: 'Monitor',
  agent: 'Subagent',
  task: 'Background task',
};

const OUTCOME_VERB: Readonly<Record<BackgroundTaskOutcome, string>> = {
  finished: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  event: '',
};

/** `Background command finished`, `Monitor failed`, `Subagent stopped`; a monitor's output is a `Monitor event`. */
export function backgroundTaskTitle(task: BackgroundTaskEvent): string {
  if (task.kind === 'monitor' && task.outcome === 'finished') return 'Monitor ended';
  if (task.kind === 'monitor' && task.outcome === 'event') return 'Monitor event';
  return [TASK_NOUN[task.kind], OUTCOME_VERB[task.outcome]].filter(Boolean).join(' ');
}

/** A system block's label as a row heading: `System reminder`, `Interrupted`. A wrapper's tag stays as written. */
export function systemBlockTitle(block: SystemBlockInfo): string {
  if (!/^[a-z ]+$/u.test(block.label)) return block.label;
  return `${block.label.charAt(0).toUpperCase()}${block.label.slice(1)}`;
}
