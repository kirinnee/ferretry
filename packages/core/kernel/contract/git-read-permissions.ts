/** Shared Git preamble: closes repository-driven hooks/helpers, optional writes and implicit lazy fetches. */
export const HARDENED_GIT_ARGUMENTS: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.external=',
  '-c',
  'protocol.allow=never',
  '-c',
  'status.relativePaths=false',
  '-c',
  'status.showUntrackedFiles=all',
] as const;

type Arg = string | null | { readonly prefix: string };
const env = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } as const;
// The exact safe overlays supplied by gitEnvironment, with/without global config and literal pathspecs.
// Keep the minimal environment for callers which supply only the mandatory read guards.
const environments = [
  env,
  ...[false, true].flatMap(global =>
    [false, true].map(literal => ({
      ...env,
      GIT_CONFIG_SYSTEM: '/dev/null',
      ...(global ? {} : { GIT_CONFIG_GLOBAL: '/dev/null' }),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_ASKPASS: '',
      ...(literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
    })),
  ),
];
const shapes = (queries: readonly (readonly Arg[])[], prefix: readonly Arg[] = []) =>
  queries.flatMap(args =>
    environments.map(env => ({
      program: 'git',
      args: [...HARDENED_GIT_ARGUMENTS, ...prefix, ...args],
      env,
    })),
  );

/** The exact shared file-index queries; null is one non-option operand, never a wildcard option list. */
export const TREE_GIT_READS = shapes([
  ['rev-parse', '--is-inside-work-tree'],
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  ['config', '--global', '--includes', '--list', '-z'],
  ['var', 'GIT_CONFIG_GLOBAL'],
  ['config', '--file', null, '--includes', '--list', '-z'],
]);

const worktreeQueries: readonly (readonly Arg[])[] = [
  ['worktree', 'list', '--porcelain', '-z'],
  ['rev-parse', '--verify', 'HEAD'],
  ['symbolic-ref', '--quiet', 'HEAD'],
  ['rev-parse', '--is-inside-work-tree'],
  ['rev-parse', '--path-format=absolute', '--show-toplevel'],
  ['rev-parse', '--absolute-git-dir'],
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
  ['check-ref-format', '--branch', null],
  ['show-ref', '--verify', '--quiet', null],
  ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
  ['rev-parse', '--verify', '--end-of-options', null],
  ['config', '--list', '--includes', '--name-only', '-z'],
  ['ls-files', '--stage', '-z'],
  ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'],
  ['for-each-ref', '--format=%(upstream)', null],
  ['rev-list', '--count', null],
  ['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes'],
  ['rev-list', '--left-right', '--count', '--end-of-options', null],
  ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
  ['merge-base', '--is-ancestor', '--end-of-options', null, null],
  ['symbolic-ref', '--quiet', null],
];

/** Worktree rows, branch/status badges and move preflight, including held common-dir and checkout metadata. */
export const WORKTREE_GIT_READS = [
  ...shapes(worktreeQueries),
  ...shapes(worktreeQueries, ['--git-dir=.']),
  ...shapes(worktreeQueries, [{ prefix: '--git-dir=' }, '--work-tree=.']),
];

/** Source relocation reads only. bundle's destination is literally stdout; diff operands follow a literal --. */
export const MOVE_SOURCE_GIT_READS = [
  ...TREE_GIT_READS,
  ...shapes([
    ['for-each-ref', '--format=%(refname)', 'refs/replace/'],
    ['config', '--get-regexp', '^filter\\.'],
    ['rev-list', '--max-count=513', null],
    ['rev-list', '--objects', null],
    ['ls-tree', '-r', '-z', null],
    ['ls-files', '--stage', '-z'],
    ['rev-parse', '--verify', 'HEAD'],
    ['rev-parse', '--verify', '-q', 'HEAD'],
    ['rev-parse', '--show-prefix'],
    ['rev-parse', '--show-toplevel'],
    ['symbolic-ref', '--short', '-q', 'HEAD'],
    ['config', '--get', 'remote.origin.url'],
    ['cat-file', '-p', null],
    ['cat-file', 'blob', null],
    ['rev-list', '--max-count=1', null, '--not', '--remotes'],
    ['bundle', 'create', '-', 'HEAD', '--not', '--remotes'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
  ]),
  ...environments.map(env => ({
    program: 'git',
    env,
    rest: 'paths' as const,
    args: [
      ...HARDENED_GIT_ARGUMENTS,
      'diff',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-relative',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      null,
      '--',
    ],
  })),
];
