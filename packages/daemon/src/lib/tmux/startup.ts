/**
 * Answering the modal dialogs a harness parks on before it will take any work.
 *
 * A launched agent does not always come up at a prompt. Claude Code asks whether you trust the
 * folder, confirms a custom API key, and gates the resume of a large session behind a menu; Codex
 * asks the trust question its own way and shows a theme picker on a fresh install. Every one of
 * these is deterministic and every one of them wedges the launch forever, because none of them is
 * ever `promptReady` — the daemon simply burned its readiness budget and reported that the agent had
 * been given no work.
 *
 * The rule this file follows is the same one picker cleanup follows: keys are returned ONLY for a
 * dialog whose affirmative path is READ OFF THE PANE. Nothing here guesses a key count, and a
 * recognised dialog whose options cannot be parsed returns nothing rather than a blind Enter.
 */
import { parseHarnessDialog } from './harness-dialog.ts';

/** A dialog whose affirmative path is known, and the exact keys that take it. */
export interface StartupDialogAction {
  readonly kind:
    | 'claude-trust'
    | 'codex-trust'
    | 'permission-bypass'
    | 'api-key'
    | 'onboarding'
    | 'resume-menu'
    | 'auto-default-nudge'
    | 'codex-update';
  readonly keys: readonly string[];
}

export interface StartupDialogOptions {
  /**
   * How to answer Claude Code's large-session resume gate ("Resume from summary (recommended) /
   * Resume full session as-is / Don't ask me again").
   *
   * `full` keeps the session's fidelity and is the default; `summary` saves quota. Option 3 is NEVER
   * selected — it mutates global account state, so a daemon choosing it would silently change how
   * every future session on that account resumes.
   */
  readonly resumeMenuChoice?: 'full' | 'summary';
}

/** One rendered menu row: whether the cursor sits on it, and its lowercased label. */
interface MenuOption {
  readonly selected: boolean;
  readonly label: string;
}

/** `❯ 1. Resume from summary (recommended)` — the cursor mark, the number, the label. */
const NUMBERED_ROW = /^\s*([>›❯»])?\s*(\d+)[.)]\s+(.+)$/u;

function menuOptions(pane: string): readonly MenuOption[] {
  return pane.split('\n').flatMap(line => {
    const match = NUMBERED_ROW.exec(line);
    return match === null ? [] : [{ selected: match[1] !== undefined, label: match[3]!.trim().toLowerCase() }];
  });
}

/**
 * The arrow keys that move the cursor from where it is to the row we want, then Enter.
 *
 * Both indices must be known. A wanted row with no visible cursor is the case that matters: pressing
 * Enter there submits whatever the harness has highlighted, which is exactly the guess this refuses
 * to make — the one exception is a wanted row that is already first, where the harness's own default
 * highlight is the row we want anyway.
 */
function keysTo(options: readonly MenuOption[], wanted: number): readonly string[] {
  if (wanted < 0) return [];
  const selected = options.findIndex(option => option.selected);
  if (selected < 0) return wanted === 0 ? ['Enter'] : [];
  const direction = wanted > selected ? 'Down' : 'Up';
  return [...Array.from({ length: Math.abs(wanted - selected) }, () => direction), 'Enter'];
}

/**
 * Claude Code's large-session resume gate.
 *
 * It appears on every resume of a big session and stays until answered, so a daemon that cannot
 * answer it cannot revive a long-running agent at all.
 */
export function resumeMenuAction(pane: string, choice: 'full' | 'summary'): StartupDialogAction | undefined {
  const lower = pane.toLowerCase();
  if (!lower.includes('resume from summary') || !lower.includes('resume full session')) return undefined;
  const options = menuOptions(pane);
  const keys = keysTo(
    options,
    options.findIndex(option =>
      choice === 'summary' ? option.label.startsWith('resume from summary') : option.label.startsWith('resume full'),
    ),
  );
  return keys.length === 0 ? undefined : { kind: 'resume-menu', keys };
}

/** `❯ No, keep bypass permissions` — the auto-default nudge draws its rows with no numbers. */
const AUTO_NUDGE_ROW = /^\s*[│|]?\s*([>›❯»])?\s*(yes, set auto mode as my default permission mode|no, keep \S.*)$/iu;

/**
 * Claude Code's one-shot "Make auto mode your default permission mode?" dialog, answered NO.
 *
 * No is the answer that changes nothing: the session keeps the permission mode its owner chose, and
 * Claude only records that the dialog was seen. Yes would rewrite the account's own default — a
 * choice no daemon gets to make. The fixed layer stops the dialog appearing at all; this is for a
 * runtime that has not been re-applied since, or a harness that brings it back another way.
 */
export function autoDefaultNudgeAction(pane: string): StartupDialogAction | undefined {
  if (!pane.toLowerCase().includes('make auto mode your default permission mode?')) return undefined;
  const options = pane.split('\n').flatMap(line => {
    const match = AUTO_NUDGE_ROW.exec(line);
    return match === null ? [] : [{ selected: match[1] !== undefined, label: match[2]!.trim().toLowerCase() }];
  });
  const keys = keysTo(
    options,
    options.findIndex(option => option.label.startsWith('no, keep')),
  );
  return keys.length === 0 ? undefined : { kind: 'auto-default-nudge', keys };
}

/**
 * Codex's "Update available" prompt, answered SKIP.
 *
 * Skip installs nothing and records nothing — measured on 0.145.0 and 0.156.1: `version.json` keeps
 * `dismissed_version` empty, so the next launch asks again and a person at the terminal still sees it.
 * "Update now" would run a package manager on the owner's machine and "Skip until next version" would
 * write their choice, so neither is ever picked. Arrows, then Enter: the update prompt acts on a digit
 * the moment it is pressed, but its rows are read off the pane like every other dialog's.
 */
export function codexUpdateAction(pane: string): StartupDialogAction | undefined {
  const dialog = parseHarnessDialog(pane);
  if (dialog?.kind !== 'update' || dialog.harness !== 'codex' || dialog.selected === undefined) return undefined;
  const skip = dialog.options.find(option => option.label.toLowerCase() === 'skip');
  if (skip === undefined) return undefined;
  const distance = skip.number - dialog.selected;
  const move = distance > 0 ? 'Down' : 'Up';
  return { kind: 'codex-update', keys: [...Array.from({ length: Math.abs(distance) }, () => move), 'Enter'] };
}

/**
 * Codex's note on a trust screen raised in a subdirectory of a Git repository (0.145.0 and 0.163.0
 * alike): saying yes there trusts the whole repository, not the launch folder the fixed layer trusts.
 */
const CODEX_TRUSTS_REPOSITORY_ROOT = 'trusting will apply to the repository root';

/** Which of the recognised trust/confirmation dialogs the frame is showing, if any. */
function dialogKind(lower: string): StartupDialogAction['kind'] | undefined {
  if (lower.includes('do you trust the contents of this directory') || lower.includes('trust this folder? codex can'))
    // A yes that would trust more than the launch folder is a new decision, so a person makes it.
    return lower.includes(CODEX_TRUSTS_REPOSITORY_ROOT) ? undefined : 'codex-trust';
  if (
    (lower.includes('quick safety check') && lower.includes('yes, i trust this folder')) ||
    lower.includes('do you trust the files')
  )
    return 'claude-trust';
  if (lower.includes('yes, i accept') && lower.includes('no, exit')) return 'permission-bypass';
  // Claude Code's "Detected a custom API key" confirmation defaults to No, and the daemon's wrappers
  // export that key deliberately — refusing it would launch the agent against the wrong account.
  if (lower.includes('do you want to use this api key')) return 'api-key';
  return undefined;
}

/** `❯ No, exit` / `  Yes, I trust this folder` — a yes/no row drawn with no number, the cursor mark optional. */
const YES_NO_ROW = /^\s*[│|]?\s*([>›❯»])?\s*((?:yes|no)\b.{0,79})$/iu;

/**
 * The rows of a dialog that draws them without numbers.
 *
 * Claude Code 2.1.281 draws its folder-trust screen as `❯ No, exit` over `  Yes, I trust this folder` —
 * the cancel row FIRST and selected — and its custom-API-key confirmation as `  Yes` over `❯ No
 * (recommended)`. With only numbered rows read, neither had any, so the dialog was recognised, no keys
 * were found, and `❯ No, exit` plus an indented `Yes…` row were read as a person's half-typed draft.
 */
function yesNoOptions(pane: string): readonly MenuOption[] {
  return pane.split('\n').flatMap(line => {
    const match = YES_NO_ROW.exec(line);
    return match === null
      ? []
      : [{ selected: match[1] !== undefined, label: (match[2] as string).trim().toLowerCase() }];
  });
}

/** The row a trust-style dialog wants: the first option that says yes. */
function affirmativeRow(options: readonly MenuOption[]): number {
  return options.findIndex(option => /\b(yes|accept|continue|trust)\b/.test(option.label));
}

/**
 * The keystrokes that clear the startup dialog on this frame, or nothing when the frame shows no
 * dialog this function knows how to answer.
 *
 * The resume menu is checked first because it is the only one whose answer is a CHOICE rather than a
 * yes: its rows also contain the word "resume", not "yes", so the affirmative search below would
 * find nothing and the pane would sit there.
 */
export function startupDialogAction(pane: string, options: StartupDialogOptions = {}): StartupDialogAction | undefined {
  const resumeMenu = resumeMenuAction(pane, options.resumeMenuChoice ?? 'full');
  if (resumeMenu !== undefined) return resumeMenu;
  // Its rows carry no numbers, so it has its own row parser rather than the affirmative search below.
  const nudge = autoDefaultNudgeAction(pane);
  if (nudge !== undefined) return nudge;
  const update = codexUpdateAction(pane);
  if (update !== undefined) return update;
  const lower = pane.toLowerCase();
  // The theme picker has no wrong answer: every row is a text style, and the harness proceeds on any
  // of them. It is the one dialog that needs no row search.
  if (lower.includes('choose the text style') || lower.includes('select theme'))
    return { kind: 'onboarding', keys: ['Enter'] };
  const kind = dialogKind(lower);
  if (kind === undefined) return undefined;
  const numbered = menuOptions(pane);
  const rows = numbered.length > 0 || (kind !== 'claude-trust' && kind !== 'api-key') ? numbered : yesNoOptions(pane);
  const keys = keysTo(rows, affirmativeRow(rows));
  return keys.length === 0 ? undefined : { kind, keys };
}
