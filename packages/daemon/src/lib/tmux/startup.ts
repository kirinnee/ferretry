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

/** A dialog whose affirmative path is known, and the exact keys that take it. */
export interface StartupDialogAction {
  readonly kind: 'claude-trust' | 'codex-trust' | 'permission-bypass' | 'api-key' | 'onboarding' | 'resume-menu';
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

/** Which of the recognised trust/confirmation dialogs the frame is showing, if any. */
function dialogKind(lower: string): StartupDialogAction['kind'] | undefined {
  if (lower.includes('do you trust the contents of this directory')) return 'codex-trust';
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
  const lower = pane.toLowerCase();
  // The theme picker has no wrong answer: every row is a text style, and the harness proceeds on any
  // of them. It is the one dialog that needs no row search.
  if (lower.includes('choose the text style') || lower.includes('select theme'))
    return { kind: 'onboarding', keys: ['Enter'] };
  const kind = dialogKind(lower);
  if (kind === undefined) return undefined;
  const rows = menuOptions(pane);
  const keys = keysTo(rows, affirmativeRow(rows));
  return keys.length === 0 ? undefined : { kind, keys };
}
