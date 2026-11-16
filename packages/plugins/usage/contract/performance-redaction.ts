/**
 * WHAT A SHAREABLE REPORT MAY SAY ABOUT A PATH OR A COMMAND.
 *
 * A performance report is made to be pasted into a chat with whoever is looking at a slow machine, so
 * nothing in it may identify what the person is working on. Two things would: the arguments of the
 * programs the daemon starts (a `tmux send-keys` carries the text being typed) and the directories
 * the daemon reads (a worktree is named after its project). This module reduces both to their SHAPE —
 * the shape is what a performance question needs anyway, because "the same file, ten thousand times"
 * and "ten thousand files, once each" only differ in the identifier this throws away.
 */

/** Where the paths a report names are rooted, so they can be written relative to it. */
export interface PathRoots {
  /** The person's home directory, written `~`. */
  readonly home: string;
  /** The daemon's state home when it is NOT under `home` (`FY_HOME` elsewhere), written `<fy-home>`. */
  readonly stateHome?: string;
}

/**
 * The top-level directories that belong to the operating system or a package manager, whose layout
 * says which program a file is and nothing about the person. Anything else outside home — `/tmp`,
 * `/Volumes`, a checkout under `/work` — keeps only its first segment and the file's own name.
 */
const SYSTEM_ROOTS = new Set([
  'proc',
  'sys',
  'dev',
  'etc',
  'usr',
  'nix',
  'lib',
  'lib64',
  'bin',
  'sbin',
  'opt',
  'System',
  'Library',
  'Applications',
]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
/** A Ferretry session id: `mvir1r5g-90731a4e`. */
const SESSION_ID = /^[a-z0-9]{6,12}-[0-9a-f]{8}$/u;
/** Dates and instants inside a file name: `rollout-2026-10-21T08-12-44-…`. */
const DATE = /\d{4}-\d{2}-\d{2}(?:[T_]\d{2}[-:]\d{2}(?:[-:]\d{2}(?:\.\d+)?)?Z?)?/gu;
const LONG_HEX = /\b[0-9a-f]{12,}\b/giu;
const NUMBER = /\d{2,}/gu;

/**
 * A directory name that is part of a program's own layout rather than the person's: a dot-directory
 * (`.ferretry`, `.claude`, `.codex`), or a short lower-case word inside one (`sessions`, `projects`).
 */
const STRUCTURAL = /^[a-z][a-z0-9_-]{0,23}$/u;

/** One path segment, with every identifier inside it replaced by its kind. */
function segmentShape(segment: string): string {
  if (SESSION_ID.test(segment)) return '<session>';
  // A Claude project directory is its working directory with `/` written `-`: the project's name.
  if (segment.startsWith('-') && segment.length > 1) return '<project>';
  if (segment.includes('@')) return '<id>';
  const shaped = segment
    .replace(UUID, '<uuid>')
    .replace(DATE, '<date>')
    .replace(LONG_HEX, '<hex>')
    .replace(NUMBER, '<n>');
  return shaped;
}

/**
 * The shape of `path`, safe to share.
 *
 * - Under the home directory, it is written from `~`.
 * - Inside a dot-directory (`~/.ferretry/…`, `~/.claude/…`) the program's own layout is kept and every
 *   identifier is replaced by its kind: `~/.ferretry/state/sessions/<session>/state.json`.
 * - Anywhere else under home — a worktree, a project — the directories are the person's, so only the
 *   file's own name survives: `~/…/.mcp.json`.
 * - Outside home, a system directory (`/proc/<n>/stat`, `/nix/store/<hash>-tmux-3.6a/…`) keeps its
 *   shaped layout, because it is the machine's, not the person's; anywhere else keeps its first segment
 *   and the file's own name: `/tmp/…/state.json`.
 * - Under a state home that is not under home, it is written from `<fy-home>` with its layout kept.
 */
export function pathShape(path: string, roots: PathRoots): string {
  if (path === '') return '<empty>';
  const home = roots.home.replace(/\/+$/u, '');
  const within = (root: string, candidate: string): boolean =>
    root !== '' && (candidate === root || candidate.startsWith(`${root}/`));
  const stateHome = roots.stateHome?.replace(/\/+$/u, '') ?? '';
  // A state home under home is already written from `~` with its layout kept (`~/.ferretry/…`).
  if (!within(home, stateHome) && within(stateHome, path)) {
    const inside = path
      .slice(stateHome.length)
      .split('/')
      .filter(segment => segment !== '');
    return ['<fy-home>', ...inside.map(keepStructural)].join('/');
  }
  const underHome = within(home, path);
  const relative = underHome ? path.slice(home.length) : path;
  const segments = relative.split('/').filter(segment => segment !== '');
  if (!underHome) {
    if (!path.startsWith('/')) return segments.length === 0 ? '<relative>' : `<relative>/${shapeTail(segments)}`;
    if (segments.length === 0) return '/';
    if (segments[0] === 'nix' && segments[1] === 'store') return `/nix/store/${shapeStore(segments.slice(2))}`;
    const [top = ''] = segments;
    if (SYSTEM_ROOTS.has(top)) return `/${segments.map(segmentShape).join('/')}`;
    if (segments.length === 1) return `/${segmentShape(top)}`;
    return segments.length === 2
      ? `/${segmentShape(top)}/${shapeTail(segments)}`
      : `/${segmentShape(top)}/…/${shapeTail(segments)}`;
  }
  if (segments.length === 0) return '~';
  const [first, ...rest] = segments as [string, ...string[]];
  if (!first.startsWith('.')) return segments.length === 1 ? `~/${segmentShape(first)}` : `~/…/${shapeTail(segments)}`;
  return `~/${[first, ...rest.map(keepStructural)].join('/')}`;
}

/** Inside a program's own directory: a structural name stays, anything else is shaped. */
function keepStructural(segment: string): string {
  const shaped = segmentShape(segment);
  return shaped === segment && !STRUCTURAL.test(segment) && !segment.includes('.') ? '<name>' : shaped;
}

/** The last segment only, shaped: a person's directories never reach the report. */
function shapeTail(segments: readonly string[]): string {
  return segmentShape(segments[segments.length - 1] ?? '');
}

/** A store path keeps its package name, which says which program it is, and drops its hash. */
function shapeStore(segments: readonly string[]): string {
  const [entry, ...rest] = segments;
  if (entry === undefined) return '';
  const named = entry.replace(/^[0-9a-z]{32}-/u, '<hash>-');
  return [named, ...rest.map(segmentShape)].join('/');
}

/** A subcommand is one plain word: `capture-pane`, `status`, `find-generic-password`. */
const SUBCOMMAND = /^[a-z][a-z0-9-]{1,40}$/u;

/**
 * The program and subcommand of a command line, and nothing else: `tmux capture-pane`, `git status`,
 * `ps`. The subcommand is the first argument that is one plain lower-case word — option values that are
 * paths, numbers or `key=value` lists never are — so no argument that could carry content survives.
 */
export function commandLabel(argv: readonly string[]): string {
  const program = argv[0] ?? '';
  const name = program.slice(program.lastIndexOf('/') + 1) || '<unknown>';
  const subcommand = argv.slice(1).find(argument => SUBCOMMAND.test(argument));
  return subcommand === undefined ? name : `${name} ${subcommand}`;
}
