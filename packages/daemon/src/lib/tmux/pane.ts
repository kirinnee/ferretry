import type { PaneActivity, PaneMetadata, PaneState } from './contracts.ts';
import { parseHarnessDialog } from './harness-dialog.ts';
import { parsePermissionPrompt } from './permission-prompt.ts';

/**
 * Screens a harness shows BEFORE it will accept any input.
 *
 * Every entry is a modal the pane sits on until somebody answers it, and a pane sitting on one is
 * not ready no matter where its cursor is. The list arrived here narrowed to three markers, and the
 * three that survived were the three that happen not to render a prompt-shaped line — so a pane
 * parked on a theme picker or a sign-in screen read as READY and the daemon typed a turn brief into
 * it.
 *
 * `startup.ts` answers the subset whose affirmative path is known; the rest still belong here,
 * because "cannot be answered automatically" and "is not ready" are different facts.
 */
const STARTUP_BLOCKERS = [
  'do you trust the contents of this directory',
  'trust this folder? codex can',
  'opening will not change saved trust',
  'do you trust the files',
  'quick safety check: is this a project you created or one you trust',
  'yes, i trust this folder',
  'press enter to continue',
  'choose the text style',
  'select theme',
  'yes, i accept',
  'no, exit',
  'invalid api key',
  'detected a custom api key',
  'do you want to use this api key',
  'sign in',
  'log in',
  // One-shot dialogs Claude can raise once it is up. Each draws a `❯ <choice>` row that reads as a
  // prompt line, so without these the daemon typed a message straight into the dialog.
  'make auto mode your default permission mode?',
  'switch your default effort to',
  'try the new fullscreen renderer?',
];

/**
 * The harness dialogs a session can sit on with NOBODY told why, each with the words a person is
 * shown for it. Every marker is the dialog's own title or question, never a word that ordinary agent
 * output could contain — this is read on every turn-watch tick, and a false match would turn a
 * working agent into "needs input".
 */
const BLOCKING_PROMPTS: readonly { readonly marker: string; readonly says: string }[] = [
  { marker: 'make auto mode your default permission mode?', says: 'Make auto mode your default permission mode?' },
  { marker: 'switch your default effort to', says: 'Switch your default effort level?' },
  { marker: 'try the new fullscreen renderer?', says: 'Try the new fullscreen renderer?' },
  { marker: 'quick safety check: is this a project you created or one you trust', says: 'Do you trust this folder?' },
  { marker: 'do you trust the files', says: 'Do you trust this folder?' },
  { marker: 'do you trust the contents of this directory', says: 'Do you trust this folder?' },
  { marker: 'trust this folder? codex can', says: 'Do you trust this folder?' },
  { marker: 'opening will not change saved trust', says: 'Open this untrusted folder restricted?' },
  { marker: 'choose the text style', says: 'Choose a text style (first-run setup)' },
  { marker: 'do you want to use this api key', says: 'Use the custom API key it detected?' },
  { marker: 'resume full session as-is', says: 'Resume from a summary, or the full session?' },
];

/**
 * Interrupt hints — the only literal strings both harnesses print while a turn runs.
 *
 * Deliberately NOT here: `background terminal running`. Codex prints that footer permanently while
 * IDLE whenever a background terminal exists, so treating it as busy makes such a session look like
 * it is working forever.
 */
const INTERRUPT_HINTS = ['esc to interrupt', 'ctrl+c to interrupt'];

/** Codex's `Working (6m52s • Esc to interrupt)`. The hint is clipped on a narrow pane, so the
 *  elapsed form has to stand on its own. */
const CODEX_ELAPSED = /\bworking\s*\(\s*\d+[ms]/;

/** Claude-family elapsed counters — `(12s · ⚒ 3.4k tokens`, `(5m 45s · ↓ 17.2k tokens`. Minutes and
 *  seconds may be space-separated, and the trailing separator dot is what stops a parenthesised
 *  number elsewhere on screen from matching. */
const CLAUDE_ELAPSED = /\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\s*[·•∙]/;

/** The same counter line seen by its token half, for frames whose elapsed clock has scrolled off. */
const TOKEN_COUNTER = /[\d.,]+k?\s*tokens\s*[·•∙]/;

/** Spinner glyph plus an animated verb ellipsis — `✻ Lollygagging…`, `✢ Fixing stall detection…`.
 *  The verb phrase can run to several words, so the bound is on length, not on word count.
 *
 *  Anchored to the START of a line: the spinner is drawn at the left edge, never inside a box. Claude
 *  2.1.281's feedback-draft panel titles itself `│ ✻ Bug report drafted: <title>… │` and stays on an
 *  IDLE screen; unanchored, its truncation ellipsis read as a spinner and held a finished session at
 *  "working" for hours. */
const SPINNER_PHRASE = /^[^\S\n]*[✻✳✶✽✢∗][^\n…]{1,120}…/mu;

/**
 * Claude's compaction status line on ANY spinner tick (&B188): `✶ Compacting conversation… (3s)`, but also the `·`
 * and ASCII `*` frames, with or without a clock. Until its counter appears the line has no `Ns ·` and no `tokens ·`,
 * and `·` is not in {@link SPINNER_PHRASE} (a bullet in prose would read busy), so the general readers miss it and an
 * idle-looking composer under it would be typed into.
 *
 * Matches the WHOLE line and only Claude's real wording (see `tests/fixtures/compaction`): a spinner glyph, exactly
 * `Compacting conversation`, an ellipsis, then nothing or a parenthetical that opens on the elapsed clock
 * (`(3s)`, `(7m 14s · ↓ 37.4k tokens)`, clipped on a narrow pane). Prose such as `  * Compacting the notes… is next`
 * therefore never reads as a compaction, however close to the composer it sits.
 */
export const COMPACTING_LINE =
  /^[^\S\n]*[·*✻✳✶✽✢∗][^\S\n]+Compacting conversation(?:…|\.\.\.)(?:[^\S\n]*\([^\S\n]*(?:\d+[^\S\n]*[hms]\b|[\d.,]+k?[^\S\n]*tokens)[^\n]*)?[^\S\n]*$/mu;

/** How many rows, counted from the last non-blank one, the status line may sit above: the status area over the composer. */
const COMPACTING_WINDOW_LINES = 12;

/** `⏺` also prefixes tool-RESULT lines whose truncation ellipsis must not read as busy, so it keeps
 *  the strict single-word form only the spinner produces — at the left edge, like the phrase. */
const SPINNER_MARK = /^[^\S\n]*⏺\s*\S+…/mu;

/** Codex's post-interrupt banner. The turn is stopped and the composer is editable, so this screen
 *  is READY — and another interrupt keystroke sent into it would quit the TUI entirely. */
const INTERRUPTED_BANNER = 'tell the model what to do differently';

const PROMPT = /^\s*[│|]?\s*[>›❯»](?:[\s ].*)?$/u;
/** A numbered selector row (`❯ 1. Yes`) is a dialog's, never a composer's. */
const SELECTOR_ROW = /^\s*[│|]?\s*[>›❯»]\s*\d+[.)]/u;

export function parsePaneMetadata(value: string): PaneMetadata {
  const [dead, exitCode, cursorX, cursorY, height, width] = value.trimEnd().split('|');
  const number = (field: string | undefined): number | undefined => {
    const parsed = Number(field);
    return field === undefined || field === '' || !Number.isFinite(parsed) ? undefined : parsed;
  };
  return {
    dead: dead === '1',
    exitCode: number(exitCode),
    cursorX: number(cursorX),
    cursorY: number(cursorY),
    height: number(height),
    width: number(width),
  };
}

/**
 * Active-turn evidence in the VISIBLE pane: interrupt hints, elapsed clocks, token counters and
 * spinner phrases.
 *
 * Ground truth for "the harness is working". A pane showing this must never be treated as idle,
 * finished, or failed — every caller that is about to send a key asks this first.
 */
export function paneShowsActiveWork(pane: string): boolean {
  return paneActiveWork(pane) !== undefined;
}

/**
 * HOW the visible pane shows active work, or `undefined` when it does not.
 *
 * `status` is the harness's live status line — an interrupt hint, an elapsed clock or a token counter,
 * which both harnesses print for as long as a turn runs. `spinner` is a spinner-shaped line and nothing
 * else: a running turn shows it too, but so can something on an idle screen that merely looks like one,
 * so it is the one reading a transcript that says the turn ENDED may overrule.
 */
export function paneActiveWork(pane: string): 'status' | 'spinner' | undefined {
  const lower = pane.toLowerCase();
  if (INTERRUPT_HINTS.some(marker => lower.includes(marker))) return 'status';
  if (CODEX_ELAPSED.test(lower) || CLAUDE_ELAPSED.test(lower) || TOKEN_COUNTER.test(lower)) return 'status';
  // A compaction is the harness working, whatever tick it is drawn on, and no ended turn in the transcript
  // may overrule it: an idle or manual compaction starts from one (&B188).
  if (paneShowsCompacting(pane)) return 'status';
  return SPINNER_PHRASE.test(pane) || SPINNER_MARK.test(pane) ? 'spinner' : undefined;
}

/** Whether the rows just above the composer show Claude's `Compacting…` line, on any spinner tick. */
export function paneShowsCompacting(pane: string): boolean {
  const rows = pane.replaceAll('\r\n', '\n').trimEnd().split('\n').slice(-COMPACTING_WINDOW_LINES);
  return COMPACTING_LINE.test(rows.join('\n'));
}

/**
 * The questions both harnesses ask before a tool runs — Claude's `Do you want to proceed?` /
 * `Do you want to make this edit to …`, Codex's `Would you like to run the following command?` /
 * `Allow command?`. Only ever read together with a numbered choice list, so prose that merely
 * contains one of these words never reads as a prompt.
 */
const PERMISSION_QUESTIONS = ['do you want to', 'would you like to', 'allow command', 'approve this'];

/** One numbered choice of a selector, cursor or not: `❯ 1. Yes`, `  2. No`, `› 1. Yes, proceed`. */
const NUMBERED_CHOICE = /^\s*[│|]?\s*(?:[>›❯»▌]\s*)?[1-9][.)]\s+\S/u;

/** How far up from the bottom of the frame a live permission prompt may sit. */
const PERMISSION_WINDOW_LINES = 25;

/**
 * A permission (or other choice) prompt the harness is blocked on, in the VISIBLE pane.
 *
 * The agent is not working and it is not the person's ordinary turn either: nothing moves until
 * somebody picks a choice. Recognition needs both halves — a permission question and at least two
 * numbered choices — within the bottom of the frame, because a choice list that has scrolled up is
 * history.
 */
export function paneShowsPermissionPrompt(pane: string): boolean {
  // Trailing blank rows first: a tall pane draws its prompt near the top and pads the rest, and those
  // rows would otherwise push the live prompt out of the window.
  const lines = pane.replaceAll('\r\n', '\n').trimEnd().split('\n').slice(-PERMISSION_WINDOW_LINES);
  const choices = lines.filter(line => NUMBERED_CHOICE.test(line)).length;
  if (choices < 2) return false;
  const lower = lines.join('\n').toLowerCase();
  return PERMISSION_QUESTIONS.some(question => lower.includes(question));
}

/**
 * The harness dialog the VISIBLE pane is parked on, as the words a person is shown for it, or
 * `undefined` when it shows none this module knows.
 *
 * Read from the bottom of the frame only, like {@link paneShowsPermissionPrompt}: a dialog that has
 * scrolled up was answered.
 */
export function paneBlockingPrompt(pane: string): string | undefined {
  const lower = pane
    .replaceAll('\r\n', '\n')
    .trimEnd()
    .split('\n')
    .slice(-PERMISSION_WINDOW_LINES)
    .join('\n')
    .toLowerCase();
  return BLOCKING_PROMPTS.find(({ marker }) => lower.includes(marker))?.says;
}

/**
 * Codex's `Waiting for startup  · esc cancel`: a submission it has accepted and PARKED.
 *
 * From Codex 0.166 the composer is drawn before startup has finished — startup waits on an
 * `account/read` round trip to chatgpt.com that can run to a fifteen-second timeout — and a payload
 * submitted in that window stays drawn in the composer with this line beneath it until startup ends,
 * when Codex sends it. Escape cancels the park and leaves the same text as an ordinary draft, which is
 * why the line, not the composer, is the proof that the submission was taken. Measured on 0.166.0
 * (`tests/fixtures/composer/codex-0.166.0-startup-*`).
 *
 * Only the LAST drawn line counts: the line sits directly under the composer, at the bottom of the
 * pane, and the same words anywhere above it are conversation — a transcript about this very screen,
 * for instance — not the harness speaking.
 */
const CODEX_STARTUP_WAIT = /^\s*waiting for startup\s+[·•]\s+esc cancel\s*$/u;

/** Whether Codex is holding a submission until its own startup finishes. */
export function paneShowsStartupWait(pane: string): boolean {
  const lines = pane.replaceAll('\r\n', '\n').trimEnd().split('\n');
  return CODEX_STARTUP_WAIT.test((lines.at(-1) ?? '').toLowerCase());
}

/** Whether the pane is working, parked, or on a modal: it shows no idle composer however it is drawn. */
function paneIsBusyOrBlocked(pane: string, lower: string): boolean {
  if (STARTUP_BLOCKERS.some(marker => lower.includes(marker)) || paneShowsActiveWork(pane)) return true;
  // A parked submission is drawn in the composer, and the composer is not idle until Codex sends it.
  if (paneShowsStartupWait(pane)) return true;
  // A permission prompt's cursor row reads as a prompt line, and a message typed into it picks a row.
  if (parsePermissionPrompt(pane) !== undefined) return true;
  // So does a harness dialog's: Codex's `› 1. Review hooks` is shaped like a composer line.
  return parseHarnessDialog(pane) !== undefined;
}

/**
 * Whether the pane shows an IDLE composer — no working line, dialog or permission prompt — whatever the
 * box holds. Unlike {@link promptIsReady} it does not ask whether a send would be accepted: a composer
 * holding an unsent draft is idle, though its cursor is on the draft and not at the prompt's first
 * column. The turn look reads this, so a quiet pane with a draft in it settles `your-turn` (&B187, &B188).
 */
export function idlePromptShown(pane: string): boolean {
  const lower = pane.toLowerCase();
  if (paneIsBusyOrBlocked(pane, lower)) return false;
  if (lower.includes(INTERRUPTED_BANNER)) return true;
  return pane
    .split('\n')
    .slice(-30)
    .some(line => PROMPT.test(line) && !SELECTOR_ROW.test(line));
}

export function promptIsReady(pane: string, cursorY?: number, cursorX?: number): boolean {
  const lower = pane.toLowerCase();
  if (paneIsBusyOrBlocked(pane, lower)) return false;
  if (lower.includes(INTERRUPTED_BANNER)) return true;
  const lines = pane.split('\n');
  if (cursorY !== undefined && cursorY >= 0 && cursorY < lines.length) {
    const line = lines[cursorY]!;
    return (cursorX === undefined || cursorX <= 2) && PROMPT.test(line) && !SELECTOR_ROW.test(line);
  }
  return lines.slice(-30).some(line => PROMPT.test(line));
}

/** Parse {@link paneActivityFormat}: the metadata fields, then the activity stamp, scrollback size and identity. */
export function parsePaneActivity(value: string): PaneActivity {
  const fields = value.trimEnd().split('|');
  const metadata = parsePaneMetadata(fields.slice(0, 6).join('|'));
  const whole = (field: string | undefined): number | undefined =>
    field !== undefined && /^\d+$/u.test(field) ? Number(field) : undefined;
  const identity = parsePaneIdentity(`${fields[8] ?? ''} ${fields[9] ?? ''}`);
  return {
    ...metadata,
    ...(whole(fields[6]) === undefined ? {} : { activityAt: whole(fields[6]) }),
    ...(whole(fields[7]) === undefined ? {} : { historySize: whole(fields[7]) }),
    ...(identity === undefined ? {} : { paneId: identity.paneId, pid: identity.pid }),
  };
}

/** A live pane's state, as `TmuxController.state` reports it, from its metadata and its captured frames. */
export function paneStateFrom(metadata: PaneMetadata, visible: string, history = ''): PaneState {
  return {
    alive: true,
    ...metadata,
    promptReady: !metadata.dead && promptIsReady(visible, metadata.cursorY, metadata.cursorX),
    history,
    visible,
  };
}

/** A frame captured earlier, with the activity it was captured under and the second the capture began. */
export interface CapturedFrame {
  readonly activity: PaneActivity;
  readonly visible: string;
  /** The UNIX second, by the same clock tmux stamps activity with, at which the capture was asked for. */
  readonly capturedAtSecond: number;
}

/**
 * Whether a frame captured earlier is certainly still the frame on screen — so it need not be captured
 * again.
 *
 * Only when nothing that moves with a redraw has moved — cursor, size, scrollback, death — AND the
 * window's last output came in a second that ENDED before the capture began. tmux stamps activity in
 * whole seconds, so output later in the very second the frame was captured would leave the stamp
 * unchanged; demanding the capture start in a later second than the stamp is what makes that
 * impossible to miss. Anything unknown answers `false`, which costs one capture, never a stale screen.
 */
export function capturedFrameIsCurrent(frame: CapturedFrame | undefined, activity: PaneActivity): boolean {
  if (frame === undefined || activity.activityAt === undefined || activity.historySize === undefined) return false;
  const before = frame.activity;
  return (
    frame.capturedAtSecond > activity.activityAt &&
    before.activityAt === activity.activityAt &&
    before.historySize === activity.historySize &&
    before.dead === activity.dead &&
    before.cursorX === activity.cursorX &&
    before.cursorY === activity.cursorY &&
    before.height === activity.height &&
    before.width === activity.width &&
    before.paneId === activity.paneId
  );
}

/**
 * Resolve a session target the way tmux does for a plain name: the session of exactly that name, else
 * the ONE session the name is a prefix of. Our names hold no glob characters (`sessionTarget` admits
 * none), so tmux's pattern pass can never match anything the exact pass did not. `undefined` when tmux
 * would refuse: nothing matches, or the prefix is ambiguous.
 */
export function resolveSessionTarget(target: string, names: Iterable<string>): string | undefined {
  const candidates: string[] = [];
  for (const name of names) {
    if (name === target) return name;
    if (name.startsWith(target)) candidates.push(name);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Parse {@link paneIdentityTableFormat}: each session's active pane, keyed by session name. A row that is
 * not its window's active pane in its session's active window is not the pane `-t <session>` names.
 */
export function parsePaneIdentityTable(output: string): ReadonlyMap<string, PaneIdentity> {
  const table = new Map<string, PaneIdentity>();
  for (const row of output.split('\n')) {
    const [session = '', active = '', paneId = '', pid = ''] = row.split('\t');
    const identity = active === '11' ? parsePaneIdentity(`${paneId} ${pid}`) : undefined;
    if (session !== '' && identity !== undefined) table.set(session, identity);
  }
  return table;
}

/** A pane's tmux id and the pid of the process it runs. */
export interface PaneIdentity {
  readonly paneId: string;
  readonly pid: number;
}

/**
 * Parse `#{pane_id} #{pane_pid}`, whatever the locale tmux printed it under.
 *
 * Neither field can hold a space, a tab or an underscore, so any one of the three separates them.
 * That matters because the separator is the one character tmux may rewrite: a tmux client with no
 * UTF-8 locale prints a tab as `_`, and a parser that split on the tab alone read `%0_2475105` as a
 * pane with no pid — which failed every session a daemon without a locale ever launched.
 */
export function parsePaneIdentity(output: string): PaneIdentity | undefined {
  const match = /^(%(?:0|[1-9][0-9]*))[\t _]([1-9][0-9]*)$/u.exec(output.trim());
  if (match === null) return undefined;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 1 ? { paneId: match[1] as string, pid } : undefined;
}
