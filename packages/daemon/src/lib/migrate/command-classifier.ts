import {
  destructiveHeads,
  destructivePackageCommands,
  destructiveScripts,
  findExecActions,
  findWritingActions,
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
  safeHeads,
  safeToolNames,
  shellCommandFlags,
  shellHeads,
  streamEditors,
  tmuxValueFlags,
  writingGitConfigFlags,
} from './command-tables.ts';
import { worstVerdict, type InflightVerdict } from './verdict.ts';

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

/**
 * `git config a b` writes the value `b`; `git config a` reads it. Operand counting is the only way
 * to tell them apart, and an unrecognised shape counts as a write.
 */
function classifyGitConfig(values: readonly string[], from: number): InflightVerdict {
  let operands = 0;
  for (let position = from; position < values.length; position++) {
    const value = values[position]!;
    if (writingGitConfigFlags.has(value)) return 'destructive_to_interrupt';
    if (readingGitConfigFlags.has(value)) return 'safe_to_kill';
    if (!value.startsWith('-')) operands++;
  }
  return operands > 1 ? 'destructive_to_interrupt' : 'safe_to_kill';
}

function classifyGit(values: readonly string[]): InflightVerdict {
  const index = headIndex(values, 'git');
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position]!;
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
function classifyShell(head: string, values: readonly string[]): InflightVerdict {
  const index = headIndex(values, head);
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position]!;
    if (shellCommandFlags.has(value)) {
      const program = unquote(
        values
          .slice(position + 1)
          .join(' ')
          .trim(),
      );
      return program ? classifyCommand(program) : 'unknown';
    }
    if (!value.startsWith('-')) return 'unknown';
  }
  return 'safe_to_kill';
}

/** `find -exec` runs an arbitrary command per match, so the payload is classified as its own. */
function classifyFindExec(rest: readonly string[]): InflightVerdict {
  const terminator = rest.findIndex(value => value === ';' || value === '\\;' || value === '+');
  const program = (terminator === -1 ? rest : rest.slice(0, terminator))
    .filter(value => value !== '{}')
    .join(' ')
    .trim();
  return program ? classifyCommand(program) : 'unknown';
}

function classifyFind(values: readonly string[]): InflightVerdict {
  for (const [position, value] of values.entries()) {
    if (findWritingActions.has(value)) return 'destructive_to_interrupt';
    if (findExecActions.has(value)) return classifyFindExec(values.slice(position + 1));
  }
  return 'safe_to_kill';
}

function classifyTmux(values: readonly string[]): InflightVerdict {
  const index = headIndex(values, 'tmux');
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position]!;
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
  return values.some(value => inPlaceFlag.test(value)) ? 'destructive_to_interrupt' : 'safe_to_kill';
}

function classifyPackageManager(head: string, values: readonly string[]): InflightVerdict {
  const index = headIndex(values, head);
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position]!;
    if (value.startsWith('-')) continue;
    if (destructivePackageCommands.has(value)) return 'destructive_to_interrupt';
    if (rearmablePackageCommands.has(value)) return 're_armable';
    if (!runCommands.has(value)) return 'unknown';
    for (let scriptPosition = position + 1; scriptPosition < values.length; scriptPosition++) {
      const script = values[scriptPosition]!;
      if (script.startsWith('-')) continue;
      if (destructiveScripts.has(script)) return 'destructive_to_interrupt';
      return rearmableScripts.has(script) ? 're_armable' : 'unknown';
    }
    return 'unknown';
  }
  return 'unknown';
}

function classifySegment(segment: string): InflightVerdict {
  // Shell expansions and output redirects can hide writes. They cannot be safely classified from argv text.
  if (/[`]|\$\(|[<>]/.test(segment)) return 'unknown';
  const values = tokens(segment);
  const head = commandHead(values);
  if (!head) return 'unknown';
  if (head === 'git') return classifyGit(values);
  if (shellHeads.has(head)) return classifyShell(head, values);
  if (head === 'find') return classifyFind(values);
  if (head === 'tmux') return classifyTmux(values);
  if (streamEditors.has(head)) return classifyStreamEditor(values);
  if (packageManagers.has(head)) return classifyPackageManager(head, values);
  if (httpHeads.has(head)) return mutatingHttp.test(segment) ? 'destructive_to_interrupt' : 'safe_to_kill';
  if (destructiveHeads.has(head)) return 'destructive_to_interrupt';
  if (rearmableHeads.has(head)) return 're_armable';
  return safeHeads.has(head) ? 'safe_to_kill' : 'unknown';
}

/** Safely classify a shell command; ambiguous syntax deliberately refuses migration. */
export function classifyCommand(command: string): InflightVerdict {
  const segments = splitSegments(command.trim());
  return segments.length === 0 ? 'unknown' : worstVerdict(segments.map(classifySegment));
}

/** Classifies non-shell harness tools without assuming unknown tools are harmless. */
export function classifyToolName(name: string): InflightVerdict {
  if (safeToolNames.has(name)) return 'safe_to_kill';
  return rearmableToolNames.has(name) ? 're_armable' : 'unknown';
}
