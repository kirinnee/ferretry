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
 * the turn-prompt path — see TURN_PROMPT.
 */

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
  /** ALWAYS the full original text, untouched — the disclosure body. */
  readonly raw: string;
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

// The daemon's own turn prompt. Anchored and path-shaped — a human sentence that
// merely mentions a `.md` file cannot match, because the whole prefix INCLUDING
// the fixed instruction clause ("now, then carefully follow every instruction
// inside it.") must be present at the start.
//
// The path is home-, layout- and platform-AGNOSTIC. Only the invariant
// `…<sep>turns<sep>turn-NNN.md` tail is matched, with `<sep>` accepting `/` or
// `\`. kteam's original anchored the state-home directory name as well, which
// this port deliberately drops: the leading directory varies by OS and user
// (`/home/<user>`, `/Users/<user>`, a Windows `C:\Users\<user>`), the state home
// is relocatable via the daemon's home input, and the segments before `turns`
// differ between Ferretry's layout (`<home>/state/sessions/<id>/turns`) and the
// shallower one migrated history carries. The fixed instruction clause, not the
// path prefix, is what keeps this rule off human prose — so pinning the directory
// name bought nothing and cost every non-default home.
const SEP = '[\\\\/]';
const TURN_PROMPT = new RegExp(
  `^Read the file .*${SEP}turns${SEP}(turn-\\d+)\\.md now, then carefully follow every instruction inside it\\.`,
  'u',
);

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
  if (/^\s*<task-notification>/u.test(text)) {
    const status = tagContent(text, 'status');
    const summaryElement = oneLine(tagContent(text, 'summary'));
    const resultLine = oneLine(firstLine(tagContent(text, 'result')));
    const parts = [summaryElement, resultLine === summaryElement ? undefined : resultLine].filter(Boolean);
    const summary = oneLine(parts.join(' · '));
    const tone = toneForStatus(status);
    return {
      label: 'task notification',
      raw: text,
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      ...(tone ? { tone } : {}),
    };
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
  const turn = TURN_PROMPT.exec(text);
  if (turn) return { label: 'turn prompt', summary: `${turn[1]}.md`, raw: text };

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
