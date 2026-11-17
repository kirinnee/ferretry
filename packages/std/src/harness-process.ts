/**
 * WHAT A HARNESS'S PROCESSES LOOK LIKE FROM OUTSIDE — two facts the move gate (Ferrets) and the job keeper (Terminals)
 * must read the same way, so they are owned once here (fact-ownership: two programs must agree on one fact).
 *
 * - {@link claudeTaskId}: Claude Code writes the stdout of EVERY Bash tool call (foreground ones too) to `…/tasks/<id>.output`, so a
 *   path like that proves nothing about whether a call was backgrounded; the id is what
 *   ties a process to the harness's own task record (the Processes tab, a kept job's attachment).
 * - {@link isHarnessCommand}: whether a command line runs a harness CLI (`claude`, `codex`, a wrapper named after one, or
 *   the script a JavaScript runtime was handed). It is how an attachment's harness is found among its ancestors.
 *
 * Pure: no IO, no clock.
 */

const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);
const HARNESS_NAME = /^\.?(claude|codex)(-[\w.-]+)?$/;
const HARNESS_PATH = /\/(@anthropic-ai\/claude-code|@openai\/codex)\//;

const basename = (word: string): string => word.split('/').at(-1) ?? '';
const stem = (word: string): string => basename(word).replace(/\.(?:[cm]?js|ts)$/, '');

/** The Claude Code task id a path names (`…/tasks/<id>.output`), or `undefined`. One rule for the CLI, the gate and the Processes view. */
export function claudeTaskId(path: string): string | undefined {
  return /\/tasks\/([A-Za-z0-9_-]{1,64})\.output$/u.exec(path)?.[1];
}

/** The program a command line runs: the script when a JavaScript runtime was handed one, else the head word. */
export function programOf(values: readonly string[]): string {
  const head = values[0] ?? '';
  if (!RUNTIMES.has(basename(head))) return head;
  return values.slice(1).find(value => !value.startsWith('-')) ?? head;
}

/** Whether these words (a command line, split) run a harness CLI. */
export function isHarnessWords(values: readonly string[]): boolean {
  const target = programOf(values);
  return HARNESS_NAME.test(stem(target)) || HARNESS_PATH.test(target);
}

/** Whether a command line runs a harness CLI (`claude`, `codex`, a wrapper named after one, or its script). */
export function isHarnessCommand(argv: string): boolean {
  return isHarnessWords(argv.split(/\s+/u).filter(Boolean));
}

/**
 * Whether these words (a command line, split) run `<binary> job attach|run …`, however the binary was spelled: `fy`,
 * `/nix/store/…/bin/fy`, `bun …/fy.ts`. It is the ONE reading of "this process is a job attachment's program", shared by
 * the keeper (which refuses to register any other process as an attachment) and the move gate (which refuses to trust any
 * other row). THE ARGV IS NECESSARY, NEVER SUFFICIENT: anything can be named like this, so the keeper's registry entry is
 * still the proof; this only keeps an unrelated program from being registered as one.
 */
export function isJobAttachWords(values: readonly string[], binaryName: string): boolean {
  // The binary is the PROGRAM: the first word, or the script a JavaScript runtime was handed (`bun …/fy.ts`).
  // `echo fy job attach` is not.
  const at = values.findIndex(value => stem(value) === binaryName);
  const asProgram = at === 0 || (at === 1 && RUNTIMES.has(basename(values[0] ?? '')));
  if (!asProgram) return false;
  return values[at + 1] === 'job' && (values[at + 2] === 'attach' || values[at + 2] === 'run');
}

/** {@link isJobAttachWords} for a command line as one string. */
export function isJobAttachCommand(argv: string, binaryName: string): boolean {
  return isJobAttachWords(argv.split(/\s+/u).filter(Boolean), binaryName);
}
