import { claudeToolShellPayload } from '@ferretry/std';
import {
  destructiveHeads,
  destructivePackageCommands,
  destructiveScripts,
  findExecActions,
  findWritingActions,
  fyGlobalFlags,
  fySendHoldingFlags,
  fySendVerb,
  fyVerbOldSpellings,
  fyVerbsWithSubverbs,
  harmlessRedirect,
  httpHeads,
  inPlaceFlag,
  mutatingHttp,
  packageManagers,
  prefixes,
  readingGitConfigFlags,
  readonlyGitCommands,
  readonlyTmuxCommands,
  rearmableHeads,
  rearmablePackageCommands,
  rearmableScripts,
  rearmableToolNames,
  runCommands,
  safeFyVerbLines,
  safeHeads,
  safeToolNames,
  shellCommandFlags,
  shellHeads,
  streamEditors,
  tmuxValueFlags,
  writingGitConfigFlags,
} from './command-tables.ts';
import { namesLongOption, normalizeLongOptions } from './long-options.ts';
import { worstVerdict, type InflightVerdict } from './verdict.ts';

/**
 * How faithfully a command's text keeps what the command said. The kernel's own command line is EXACT (`/proc`'s NUL
 * separated words, newlines and all); `ps` and any display copy print each control character as `?`, so the text is LOSSY:
 * a `?` may have been a newline, and a command that was several lines may read as one. Text from a harness transcript
 * is exact.
 */
export type CommandReading = 'exact' | 'lossy';

/** What `ps` prints for a control character, newlines included. */
const LOSSY_MARK = '?';

/** `fd`'s placeholders for the matched path (`{}`, `{/}`, `{//}`, `{.}`, `{/.}`), as `find`'s `{}`. */
const execPlaceholder = /^\{[/.]*\}$/;

function basename(word: string): string {
  const parts = word.split('/');
  return parts.at(-1) ?? '';
}

function unquote(word: string): string {
  return word.replace(/^['"]|['"]$/g, '');
}

function splitSegments(command: string): readonly string[] {
  return command
    .split(/\|\||&&|[|;&\n]/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function tokens(segment: string): readonly string[] {
  return segment.split(/\s+/).filter(Boolean);
}

function commandHead(values: readonly string[]): string | undefined {
  for (const token of values) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const word = basename(unquote(token));
    if (!word || prefixes.has(word) || /^\d+[smhd]?$/.test(word) || word.startsWith('-')) continue;
    return word;
  }
  return undefined;
}

/** Index of the head itself, so subcommand scans start after the wrappers rather than at zero. */
function headIndex(values: readonly string[], head: string): number {
  return values.findIndex(value => basename(unquote(value)) === head);
}

/** The long options of `git config` that write; each also reads as any prefix of it. */
const gitConfigWritingLong: readonly string[] = [...writingGitConfigFlags].filter(flag => flag.startsWith('--'));

/**
 * `git config a b` writes the value `b`; `git config a` reads it. Operand counting is the only way
 * to tell them apart, and an unrecognised shape counts as a write.
 */
function classifyGitConfig(raw: readonly string[], from: number): InflightVerdict {
  // git accepts any unambiguous prefix of a long option and `--opt=value`: a writing flag is looked for in the whole
  // command first, in its normalised spelling, so no reading flag before it can hide it.
  const values = [...raw.slice(0, from), ...normalizeLongOptions(raw.slice(from), gitConfigWritingLong)];
  if (values.slice(from).some(value => writingGitConfigFlags.has(value))) return 'destructive_to_interrupt';
  let operands = 0;
  for (let position = from; position < values.length; position++) {
    const value = values[position] ?? '';
    if (readingGitConfigFlags.has(value)) return 'safe_to_kill';
    if (!value.startsWith('-')) operands++;
  }
  return operands > 1 ? 'destructive_to_interrupt' : 'safe_to_kill';
}

function classifyGit(values: readonly string[]): InflightVerdict {
  const index = headIndex(values, 'git');
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position] ?? '';
    if (value.startsWith('-')) {
      if (value === '-C' || value === '-c') position++;
      continue;
    }
    if (value === 'config') return classifyGitConfig(values, position + 1);
    return readonlyGitCommands.has(value) ? 'safe_to_kill' : 'destructive_to_interrupt';
  }
  return 'safe_to_kill';
}

/**
 * A bare interpreter is the pane's idle login shell. One handed a script file is opaque — the
 * process table shows the wrapper, never what the script does — so it stays unknown, and one
 * handed `-c` is classified by the program it was given.
 */
function classifyShell(head: string, values: readonly string[], lossy: boolean): InflightVerdict {
  const index = headIndex(values, head);
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position] ?? '';
    if (shellCommandFlags.has(value)) {
      const program = unquote(
        values
          .slice(position + 1)
          .join(' ')
          .trim(),
      );
      // A program read from a lossy text may have had newlines turned into `?`: it cannot be read exactly.
      if (lossy && program.includes(LOSSY_MARK)) return 'unknown';
      return program ? classifyText(program, lossy) : 'unknown';
    }
    if (!value.startsWith('-')) return 'unknown';
  }
  return 'safe_to_kill';
}

/** `find -exec` runs an arbitrary command per match, so the payload is classified as its own. */
function classifyFindExec(rest: readonly string[], lossy: boolean): InflightVerdict {
  const terminator = rest.findIndex(value => value === ';' || value === '\;' || value === '+');
  const program = (terminator === -1 ? rest : rest.slice(0, terminator))
    .filter(value => !execPlaceholder.test(value))
    .join(' ')
    .trim();
  if (lossy && program.includes(LOSSY_MARK)) return 'unknown';
  return program ? classifyText(program, lossy) : 'unknown';
}

function classifyFind(values: readonly string[], lossy: boolean): InflightVerdict {
  for (const [position, value] of values.entries()) {
    if (findWritingActions.has(value)) return 'destructive_to_interrupt';
    if (findExecActions.has(value)) return classifyFindExec(values.slice(position + 1), lossy);
  }
  return 'safe_to_kill';
}

/** A bundle of short flags (`-rn`, `-o`, `-ofile`) that includes the letter, but never a long option. */
function hasShortFlag(value: string, letter: string): boolean {
  return value.startsWith('-') && !value.startsWith('--') && value.slice(1).includes(letter);
}

/**
 * Read-only programs that write or run something through ONE option. Each is judged by its own arguments; a shape this
 * does not recognise as a write is read-only only because the program has no other way to write.
 *
 * - `yq -i` / `--inplace` rewrites the file, `-s` / `--split-exp` writes one per match;
 * - `sort -o` / `--output` writes the file (and `--compress-program` runs one);
 * - `tree -o` writes the listing to a file;
 * - `uniq <input> <output>` — a second operand — writes the file;
 * - `fd -x/-X/--exec/--exec-batch` runs a command per match: that command is classified as `find -exec`'s is;
 * - `ugrep --save-config` writes a file and `--filter` runs a command; `rg --pre` runs one.
 */
const guardedHeads: ReadonlyMap<string, (rest: readonly string[], lossy: boolean) => InflightVerdict> = new Map([
  [
    'yq',
    rest =>
      rest.some(value => hasShortFlag(value, 'i') || hasShortFlag(value, 's')) || namesLongOption(rest, yqWriting)
        ? 'destructive_to_interrupt'
        : 'safe_to_kill',
  ],
  [
    'sort',
    rest =>
      rest.some(value => hasShortFlag(value, 'o')) || namesLongOption(rest, sortWriting)
        ? 'destructive_to_interrupt'
        : 'safe_to_kill',
  ],
  [
    'tree',
    rest =>
      rest.some(value => hasShortFlag(value, 'o')) || namesLongOption(rest, treeWriting)
        ? 'destructive_to_interrupt'
        : 'safe_to_kill',
  ],
  ['uniq', rest => (uniqOperands(rest) > 1 ? 'destructive_to_interrupt' : 'safe_to_kill')],
  ['fd', (rest, lossy) => classifyFd(rest, lossy)],
  ['ugrep', rest => classifyUgrep(rest)],
  ['ug', rest => classifyUgrep(rest)],
  ['rg', rest => (namesLongOption(rest, rgRunning) ? 'unknown' : 'safe_to_kill')],
]);

/** The long options that write a file or run a program, per tool; see {@link normalizeLongOptions}. */
const yqWriting = ['--inplace', '--split-exp'];
const sortWriting = ['--output', '--compress-program'];
const treeWriting = ['--output'];
const fdRunning = ['--exec', '--exec-batch'];
const ugrepWriting = ['--save-config', '--filter'];
const rgRunning = ['--pre', '--hostname-bin'];
const streamEditorWriting = ['--in-place', '--include'];
/** `uniq`'s options whose number is the next word, so it is not a file operand. */
const uniqNumbered = ['--skip-fields', '--skip-chars', '--check-chars'];

/** The files `uniq` is handed: its operands, past the options that take a number as their next word. */
function uniqOperands(raw: readonly string[]): number {
  const rest = normalizeLongOptions(raw, uniqNumbered);
  let operands = 0;
  for (let position = 0; position < rest.length; position++) {
    const value = rest[position] ?? '';
    if (value === '--') {
      operands += rest.length - position - 1;
      break;
    }
    if (value === '-f' || value === '-s' || value === '-w' || uniqNumbered.includes(value)) position++;
    else if (!value.startsWith('-') || value === '-') operands++;
  }
  return operands;
}

/** `--exec=rm {}` and `--exec rm {}` are the same payload, as is an abbreviated option; see {@link normalizeLongOptions}. */
function classifyFd(raw: readonly string[], lossy: boolean): InflightVerdict {
  const rest = normalizeLongOptions(raw, fdRunning);
  const position = rest.findIndex(
    value => fdRunning.includes(value) || hasShortFlag(value, 'x') || hasShortFlag(value, 'X'),
  );
  return position === -1 ? 'safe_to_kill' : classifyFindExec(rest.slice(position + 1), lossy);
}

function classifyUgrep(rest: readonly string[]): InflightVerdict {
  return namesLongOption(rest, ugrepWriting) ? 'destructive_to_interrupt' : 'safe_to_kill';
}

function classifyTmux(values: readonly string[]): InflightVerdict {
  const index = headIndex(values, 'tmux');
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position] ?? '';
    if (tmuxValueFlags.has(value)) {
      position++;
      continue;
    }
    if (value.startsWith('-')) continue;
    return readonlyTmuxCommands.has(value) ? 'safe_to_kill' : 'destructive_to_interrupt';
  }
  return 'safe_to_kill';
}

/** Without an in-place flag a stream editor only writes to stdout, which the relaunch discards. */
function classifyStreamEditor(values: readonly string[]): InflightVerdict {
  const normalized = normalizeLongOptions(values, streamEditorWriting);
  return normalized.some(value => inPlaceFlag.test(value) || value === '--include')
    ? 'destructive_to_interrupt'
    : 'safe_to_kill';
}

function classifyPackageManager(head: string, values: readonly string[]): InflightVerdict {
  const index = headIndex(values, head);
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position] ?? '';
    if (value.startsWith('-')) continue;
    if (destructivePackageCommands.has(value)) return 'destructive_to_interrupt';
    if (rearmablePackageCommands.has(value)) return 're_armable';
    if (!runCommands.has(value)) return 'unknown';
    for (let scriptPosition = position + 1; scriptPosition < values.length; scriptPosition++) {
      const script = values[scriptPosition] ?? '';
      if (script.startsWith('-')) continue;
      if (destructiveScripts.has(script)) return 'destructive_to_interrupt';
      return rearmableScripts.has(script) ? 're_armable' : 'unknown';
    }
    return 'unknown';
  }
  return 'unknown';
}

/**
 * The option names the `fy` shell reads from the words after a verb, spelt as the shell's own `parseArgs` reads them
 * (the shell is the CLI package, which the daemon does not import, so the rule is restated here and a test pins it):
 * a word that starts with `-` and is not a negative number is an option; ONE or TWO leading dashes are stripped
 * (`-now` is `--now`); everything from the first `=` is the value (`--now=true` is `now`); a `--no-x` is also
 * reported as `x`, which over-reports (it is an off switch) and so errs closed. `--` ends the options.
 */
function fyOptionNames(rest: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const token of rest) {
    if (token === '--') break;
    if (!token.startsWith('-') || token === '-' || /^-\d/u.test(token)) continue;
    const body = token.replace(/^-{1,2}/u, '');
    const name = body.includes('=') ? body.slice(0, body.indexOf('=')) : body;
    names.add(name);
    if (name.startsWith('no-') && name.length > 3) names.add(name.slice(3));
  }
  return names;
}

/**
 * `fy <verb>`: safe only for the verbs {@link safeFyVerbs} names (and `task show|note`). The verb is the first word
 * after the binary, past the one global flag; anything else — another flag first, a verb not listed — is unknown.
 */
function classifyFy(values: readonly string[]): InflightVerdict {
  const index = headIndex(values, 'fy');
  let position = index + 1;
  while (fyGlobalFlags.has(values[position] ?? '')) position++;
  const typed = values[position] ?? '';
  const verb = fyVerbOldSpellings.get(typed) ?? typed;
  const rest = values.slice(position + 1);
  if (verb === fySendVerb)
    return [...fyOptionNames(rest)].some(name => fySendHoldingFlags.has(`--${name}`)) ? 'unknown' : 're_armable';
  if (!fyVerbsWithSubverbs.has(verb)) return safeFyVerbLines.includes(verb) ? 'safe_to_kill' : 'unknown';
  // `guide` / `task`: the first word that is not an option is the sub-verb, so `guide --json accept r` is `guide accept`.
  // No sub-verb is the bare verb, safe only where the bare verb is listed (`guide` is, `task` is not).
  const sub = rest.find(value => !value.startsWith('-'));
  return safeFyVerbLines.includes(sub === undefined ? verb : `${verb} ${sub}`) ? 'safe_to_kill' : 'unknown';
}

function classifySegment(segment: string, lossy: boolean): InflightVerdict {
  // Shell expansions and output redirects can hide writes. They cannot be safely classified from argv text.
  if (/[`]|\$\(|[<>]/.test(segment)) return 'unknown';
  const values = tokens(segment);
  const head = commandHead(values);
  if (!head) return 'unknown';
  if (head === 'git') return classifyGit(values);
  if (head === 'fy') return classifyFy(values);
  if (shellHeads.has(head)) return classifyShell(head, values, lossy);
  if (head === 'find') return classifyFind(values, lossy);
  const guard = guardedHeads.get(head);
  if (guard !== undefined) return guard(values.slice(headIndex(values, head) + 1), lossy);
  if (head === 'tmux') return classifyTmux(values);
  if (streamEditors.has(head)) return classifyStreamEditor(values);
  if (packageManagers.has(head)) return classifyPackageManager(head, values);
  if (httpHeads.has(head)) return mutatingHttp.test(segment) ? 'destructive_to_interrupt' : 'safe_to_kill';
  if (destructiveHeads.has(head)) return 'destructive_to_interrupt';
  if (rearmableHeads.has(head)) return 're_armable';
  return safeHeads.has(head) ? 'safe_to_kill' : 'unknown';
}

/**
 * Safely classify a shell command; ambiguous syntax deliberately refuses move.
 *
 * A command that is EXACTLY a Claude Code Bash tool shell is classified by the command inside it: the wrapper's fixed
 * boilerplate (`2>/dev/null`, `< /dev/null`, `pwd -P >| …-cwd`) is not the agent's, while the payload's own redirects
 * and expansions still count, exactly as if it had been typed alone. A wrapper that is not exactly that shape is
 * classified as the opaque shell it then is. Codex's `bash -lc <command>` is {@link classifyShell}'s.
 */
export function classifyCommand(command: string, reading: CommandReading = 'exact'): InflightVerdict {
  return classifyText(command, reading === 'lossy');
}

function classifyText(command: string, lossy: boolean): InflightVerdict {
  const payload = claudeToolShellPayload(command);
  // A payload that may have lost its newlines to `?` is not unwrapped: judged by its first line it would hide the rest.
  if (payload !== undefined && !(lossy && payload.includes(LOSSY_MARK))) return classifyText(payload, lossy);
  const segments = splitSegments(command.replace(harmlessRedirect, '').trim());
  return segments.length === 0 ? 'unknown' : worstVerdict(segments.map(segment => classifySegment(segment, lossy)));
}

/** Classifies non-shell harness tools without assuming unknown tools are harmless. */
export function classifyToolName(name: string): InflightVerdict {
  if (safeToolNames.has(name)) return 'safe_to_kill';
  return rearmableToolNames.has(name) ? 're_armable' : 'unknown';
}

/**
 * Classifies one running process from its argv as the process table shows it.
 *
 * Two things differ from {@link classifyCommand}, which reads command TEXT a shell would still parse. A process
 * whose first word is a read-only program was exec'd directly — no shell stands between, so a `|`, `;`, `>` or
 * `$(` in its arguments is a literal argument (`ugrep -E ✖|refused`, the shell having already taken the quotes off),
 * and the program is what decides. Everything else, including every shell and every harness wrapper, is the
 * command-text classification.
 */
export function classifyProcessArgv(argv: string, reading: CommandReading = 'lossy'): InflightVerdict {
  const words = tokens(argv.trim());
  const first = basename(unquote(words[0] ?? ''));
  if (shellHeads.has(first) || prefixes.has(first)) return classifyCommand(argv, reading);
  const guard = guardedHeads.get(first);
  if (guard !== undefined) return guard(words.slice(1), reading === 'lossy');
  return safeHeads.has(first) ? 'safe_to_kill' : classifyCommand(argv, reading);
}

/** The `fy` verb that asks for a move: `fy ferret move <id>`. */
const moveVerb: readonly string[] = ['ferret', 'move'];

/**
 * Whether ONE command (a single segment, or a process's argv) is a call of `fy` that asks for a move. Anything a shell
 * would expand or redirect is not: it cannot be read as the call it looks like. The binary is `fy` (or the preview
 * `fy5`), alone or behind a `bun`/`node` that runs it.
 */
export function isMoveRequest(command: string): boolean {
  if (/[`]|\$\(|[<>]/.test(command.replace(harmlessRedirect, ''))) return false;
  const values = tokens(command.replace(harmlessRedirect, '').trim());
  let position = values.findIndex(value => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value));
  if (position === -1) return false;
  if (/^(bun|node)$/.test(basename(unquote(values[position] ?? '')))) position++;
  if (!/^fy\d*$/.test(basename(unquote(values[position] ?? '')))) return false;
  position++;
  while (fyGlobalFlags.has(values[position] ?? '')) position++;
  return moveVerb.every((word, index) => values[position + index] === word);
}

/** The program a shell was handed: a Claude tool shell's payload, or what follows `-c`; `undefined` for a script file. */
function shellProgram(argv: string): string | undefined {
  const payload = claudeToolShellPayload(argv);
  if (payload !== undefined) return payload;
  const values = tokens(argv.trim());
  const head = basename(unquote(values[0] ?? ''));
  if (!shellHeads.has(head)) return undefined;
  const flag = values.findIndex(value => shellCommandFlags.has(value));
  return flag === -1
    ? undefined
    : unquote(
        values
          .slice(flag + 1)
          .join(' ')
          .trim(),
      );
}

/**
 * What a shell that was running a move request would still be doing besides it: the shell's program with the `fy` call's
 * segment taken out, classified as usual. `safe_to_kill` means nothing else is lost (`fy ferret move me`, `cd x && fy ferret move me`);
 * `git stash && fy ferret move me && git stash pop` or a `while …; do …; fy ferret move me; done` loop is not.
 * A shell whose program cannot be read (a script file, a lossy text with a possible newline) is `unknown`.
 */
export function classifyAroundMoveRequest(
  argv: string,
  reading: CommandReading = 'lossy',
  isCall: (segment: string) => boolean = isMoveRequest,
): InflightVerdict {
  const program = shellProgram(argv);
  if (program === undefined || program === '' || (reading === 'lossy' && program.includes(LOSSY_MARK)))
    return 'unknown';
  // A pipeline's stages are separate processes, each judged on its own by the gate, so a single `|` does not split here:
  // only the commands strung together with `;`, `&&`, `||`, `&` or a newline are the shell's own work.
  const rest = program
    .replace(harmlessRedirect, '')
    .split(/\|\||&&|[;&\n]/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '' && !isCall(segment));
  return rest.length === 0
    ? 'safe_to_kill'
    : worstVerdict(
        rest.map(segment =>
          // A nested `sh -c "fy ferret move me"` is the same question one shell deeper.
          shellProgram(segment) === undefined
            ? classifySegment(segment, reading === 'lossy')
            : classifyAroundMoveRequest(segment, reading, isCall),
        ),
      );
}
