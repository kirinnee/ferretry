/**
 * `--help` text, rendered from the verb table and nothing else: the verb line's placeholders, the declared
 * `args` and `options`, and the summary. There is no hand-written help per verb. Pure.
 */
import type { VerbArgDecl } from '@ferretry/kernel/manifest';
import type { VerbEntry, VerbTable } from './verbs.ts';

const WIDTH = 80;
/** A left column wider than this puts its sentence on the next line instead of gluing it on. */
const MAX_LEFT = 34;
const INDENT = '  ';

const HELP_OPTION = { flag: '-h, --help', help: 'show this help' } as const;

const PLACEHOLDER = /^(?:<([A-Za-z][\w-]*)(\.\.\.)?>|\[([A-Za-z][\w-]*)(\.\.\.)?\])$/u;

/** The arguments of a verb: its declared `args`, else the placeholders its verb line spells (without a sentence). */
export function argsOf(entry: Pick<VerbEntry, 'line' | 'args'>): readonly VerbArgDecl[] {
  if (entry.args !== undefined) return entry.args;
  const found: VerbArgDecl[] = [];
  for (const word of entry.line.trim().split(/\s+/u)) {
    const match = PLACEHOLDER.exec(word);
    if (match === null) continue;
    const required = match[1] !== undefined;
    found.push({
      name: (match[1] ?? match[3]) as string,
      help: '',
      ...(required ? {} : { optional: true }),
      ...((match[2] ?? match[4]) === undefined ? {} : { variadic: true }),
    });
  }
  return found;
}

/** `<id>`, `[id]`, `[words...]`. */
function argUsage(arg: VerbArgDecl): string {
  const name = `${arg.name}${arg.variadic === true ? '...' : ''}`;
  return arg.optional === true ? `[${name}]` : `<${name}>`;
}

/** Wraps one sentence to `width` columns on spaces. A word longer than the width stays whole. */
export function wrap(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u).filter(each => each.length > 0)) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line.length === 0 ? word : `${line} ${word}`;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** Two aligned columns under one indent: the right column wraps; a left that is too wide takes its own line. */
function columns(rows: readonly (readonly [string, string])[], floor = 0): readonly string[] {
  if (rows.length === 0) return [];
  const widest = Math.max(floor, ...rows.map(([left]) => left.length));
  const leftWidth = Math.min(widest, MAX_LEFT) + 2;
  const hanging = ' '.repeat(INDENT.length + leftWidth);
  const out: string[] = [];
  for (const [left, right] of rows) {
    const text = wrap(right, Math.max(20, WIDTH - INDENT.length - leftWidth));
    if (text.length === 0) out.push(`${INDENT}${left}`);
    else if (left.length + 2 > leftWidth) {
      out.push(`${INDENT}${left}`);
      for (const line of text) out.push(`${hanging}${line}`);
    } else {
      out.push(`${INDENT}${left.padEnd(leftWidth)}${text[0] as string}`);
      for (const line of text.slice(1)) out.push(`${hanging}${line}`);
    }
  }
  return out;
}

const verbName = (entry: VerbEntry): string => entry.words.join(' ');

/** The verbs under a group prefix (`terminal` → `terminal open`, …), never the prefix's own verb. */
export function verbsUnder(table: VerbTable, prefix: readonly string[]): readonly VerbEntry[] {
  return table.entries.filter(
    entry => entry.words.length > prefix.length && prefix.every((word, index) => entry.words[index] === word),
  );
}

/** `fy --help`: the shell's verbs, then each plugin's, in aligned columns with wrapped sentences. */
export function renderRootHelp(binary: string, table: VerbTable, titles: Readonly<Record<string, string>>): string {
  const lines = [
    `Usage: ${binary} <verb> [arguments] [--option value]`,
    '',
    `Run \`${binary} <verb> --help\` or \`${binary} help <verb>\` for a verb's arguments and options;`,
    `\`${binary} <group> --help\` lists the verbs of a group such as \`terminal\` or \`device\`.`,
    '',
  ];
  const owners = [...new Set(table.entries.map(entry => entry.owner))];
  const all = table.entries.map(verbName);
  const widest = Math.min(Math.max(0, ...all.map(each => each.length)), MAX_LEFT);
  for (const owner of owners) {
    lines.push(owner === 'shell' ? 'The shell' : (titles[owner] ?? owner));
    const rows = table.entries
      .filter(candidate => candidate.owner === owner)
      .map((entry): readonly [string, string] => [verbName(entry), entry.summary ?? '']);
    // One left-column width for the whole list, so the columns line up from one owner to the next.
    lines.push(...columns(rows, widest));
    lines.push('');
  }
  lines.push('Options:');
  lines.push(
    ...columns([
      ['--as-owner', "inside a ferret's pane, act with the owner's credential instead of the ferret's own"],
      ['-v, --version', 'print the version'],
      ['-h, --help', 'print this list'],
    ]),
  );
  return lines.join('\n');
}

/** `Usage: fy lesson suggest <rule> [options]`: the first line of a verb's help, and of the refusal of a missing option. */
export function usageLine(binary: string, entry: VerbEntry): string {
  return `Usage: ${[binary, ...entry.words, ...argsOf(entry).map(argUsage), '[options]'].join(' ')}`;
}

/** One verb: usage, summary, its arguments and options, and the verbs below it when it is also a group. */
export function renderVerbHelp(binary: string, entry: VerbEntry, table: VerbTable): string {
  const args = argsOf(entry);
  const below = verbsUnder(table, entry.words);
  const lines = [usageLine(binary, entry)];
  if (entry.summary !== undefined) lines.push('', ...wrap(entry.summary, WIDTH));
  if (args.length > 0) lines.push('', 'Arguments:', ...columns(args.map(arg => [arg.name, arg.help] as const)));
  lines.push(
    '',
    'Options:',
    ...columns([...(entry.options ?? []).map(option => [option.flag, option.help] as const), [...pair(HELP_OPTION)]]),
  );
  if (below.length > 0) lines.push('', ...groupList(binary, entry.words, below));
  return lines.join('\n');
}

const pair = (option: { readonly flag: string; readonly help: string }): readonly [string, string] => [
  option.flag,
  option.help,
];

function groupList(binary: string, prefix: readonly string[], below: readonly VerbEntry[]): readonly string[] {
  const rows = below.map((entry): readonly [string, string] => {
    const rest = entry.words.slice(prefix.length).join(' ');
    const args = argsOf(entry).map(argUsage).join(' ');
    return [args === '' ? rest : `${rest} ${args}`, entry.summary ?? ''];
  });
  return [
    'Verbs:',
    ...columns(rows),
    '',
    `Run \`${binary} ${prefix.join(' ')} <verb> --help\` for one verb's arguments and options.`,
  ];
}

/** `fy <group> --help`: what a bare group word (`terminal`, `device`) holds. */
export function renderGroupHelp(binary: string, prefix: readonly string[], table: VerbTable): string {
  const below = verbsUnder(table, prefix);
  return [
    `Usage: ${binary} ${prefix.join(' ')} <verb> [arguments] [options]`,
    '',
    ...groupList(binary, prefix, below),
  ].join('\n');
}
