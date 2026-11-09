/**
 * The preview's two programs: `dryRun` says what a run would do and touches nothing; `prepare` makes the preview
 * home from a v4 home and proves v4 was left alone. Neither starts a daemon. Every path is a parameter so a test
 * runs both in temp folders.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { convert } from '../src/convert.ts';
import type { LockProbe } from '../src/preflight.ts';
import { type ConversionReport, summarise } from '../src/report.ts';
import { ALLOWED, LEFT_BEHIND, PREVIEW, SESSION_FILES, stepPlan } from './plan.ts';
import { guardTarget, hasMarker, PREVIEW_MARKER, PREVIEW_MARKER_TEXT } from './paths.ts';
import { compare, snapshot, VOLATILE, type Verdict } from './proof.ts';
import { stage, walk } from './stage.ts';

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** The staging folder is a private copy; it sits beside the preview home, never inside v4's. */
export const stagingFor = (target: string) => `${target}.staging`;

export async function dryRun(v4Home: string, target: string): Promise<string> {
  const walked = await walk(v4Home);
  const plan = stepPlan();
  const groups = new Map<string, { files: number; bytes: number }>();
  for (const file of walked.files) {
    const parts = file.path.split('/');
    const key =
      parts[0] === 'state' && parts[1] === 'sessions'
        ? 'state/sessions/<ferret>/<allowed files>'
        : parts.slice(0, 2).join('/');
    const row = groups.get(key) ?? { files: 0, bytes: 0 };
    groups.set(key, { files: row.files + 1, bytes: row.bytes + file.bytes });
  }
  const lines: string[] = [
    `DRY RUN: nothing is copied, converted, started or written. v4 home: ${v4Home}`,
    `preview home: ${target}   port ${PREVIEW.port}   wrapper ${join(target, 'bin', PREVIEW.wrapper)}`,
    '',
    `WOULD COPY ${walked.files.length} files (${mib(walked.files.reduce((sum, file) => sum + file.bytes, 0))}) into ${stagingFor(target)}:`,
    ...[...groups]
      .sort()
      .map(([key, row]) => `  ${String(row.files).padStart(6)} files  ${mib(row.bytes).padStart(10)}  ${key}`),
    '',
    `ferret files copied (each ferret folder): ${SESSION_FILES.join(', ')}`,
    `allowlist rows: ${ALLOWED.length}. SQLite files, if any, are copied through the engine (VACUUM INTO).`,
    '',
    'LEFT OUT BY PATH, BEFORE ANY COPY (a left folder is counted, never listed):',
    ...LEFT_BEHIND.map(row => `  ${row.path.padEnd(70)} ${row.why}`),
    `  walk found ${walked.left.length} top-level or per-ferret items left (credential and harness folders among them, unlisted).`,
    '',
    `CONVERTER STEPS THAT RUN (${plan.run.length}): ${plan.run.map(step => step.id).join(', ')}`,
    `CONVERTER STEPS SKIPPED (${plan.skipped.length}):`,
    ...plan.skipped.map(step => `  ${step.id.padEnd(16)} ${step.why}`),
    ...(plan.unknown.length > 0 ? [`  UNKNOWN skipped ids (a step was renamed): ${plan.unknown.join(', ')}`] : []),
    '',
    'IN THE PREVIEW HOME EVERY FERRET IS STOPPED: no launch command, no terminal handle, no transcript pointer, no',
    'credential hash, no token ledger, no worktree ownership. The runtimes config says autoResume: false.',
    'LOGINS ARE LEFT OUT ENTIRELY (config/logins is not copied): you add logins fresh in the preview.',
    `LAST GATE: the home is refused (files named, never their content) if any file holds "${v4Home}/", "<your home>/.claude" or "<your home>/.codex".`,
    '',
    'THEN: fresh daemon identity and empty vault come from the 5.0 daemon at first start; nothing from v4 is reused.',
    `START (owner): ${join(target, 'bin', PREVIEW.wrapper)} daemon start   (FY_HOME, FY_PORT=${PREVIEW.port}, FY_URL pinned to it; no service unit)`,
    '',
    `PROOF v4 was untouched: config files hashed and credential paths stat'ed (never read) before and after. Volatile, not hashed:`,
    ...VOLATILE.map(row => `  ${row}`),
  ];
  return lines.join('\n');
}

export interface PrepareInputs {
  readonly v4Home: string;
  readonly target: string;
  readonly lock: LockProbe;
  readonly now: () => Date;
  /** The user's home directory, for the path guard and the last gate; defaults to the real one. */
  readonly home?: string;
}

export interface Prepared {
  readonly report: ConversionReport | undefined;
  readonly summary: string;
  readonly proof: Verdict;
  readonly changedWhileCopying: readonly string[];
  /** Files (relative, names only) the last gate found naming v4's home or a harness home; the home was removed. */
  readonly gate: readonly string[];
}

/**
 * The last gate: every file of the finished home is searched for a path into v4's home or into the user's harness
 * homes. Returns the files' names, never their content. A hit means a path the converter did not scrub could make the
 * preview touch v4.
 */
export async function gateFiles(target: string, v4Home: string, home: string): Promise<string[]> {
  const claude = `${home}/.claude`;
  const codex = `${home}/.codex`;
  const hits: string[] = [];
  const scan = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) {
        const text = (await readFile(path)).toString('latin1');
        if (namesV4(text, v4Home) || text.includes(claude) || text.includes(codex)) hits.push(relative(target, path));
      }
    }
  };
  await scan(target);
  return hits.sort();
}

/** `v4Home` followed by anything that ends a path component: `<v4 home>-v5` and `<v4 home>.staging` are other folders. */
function namesV4(text: string, v4Home: string): boolean {
  for (let at = text.indexOf(v4Home); at >= 0; at = text.indexOf(v4Home, at + 1)) {
    const next = text[at + v4Home.length];
    if (next === undefined || !/[\w.-]/u.test(next)) return true;
  }
  return false;
}

/** Stage, convert, delete the staging copy, prove v4 unchanged. Refuses a target that exists and is not empty. */
export async function prepare(inputs: PrepareInputs): Promise<Prepared> {
  const home = inputs.home ?? homedir();
  const guarded = guardTarget(inputs.v4Home, inputs.target, home);
  const { v4Home, target } = guarded;
  const existing = await readdir(target).catch(() => undefined);
  if (existing !== undefined && existing.length > 0)
    throw new Error(`${target} is not empty; the preview is made once. Run clean first.`);

  const before = await snapshot(v4Home, home);
  const staging = guarded.staging;
  await rm(staging, { recursive: true, force: true });
  const staged = await stage(v4Home, staging);

  // The converter reads the host only for the archive-setting step, which is skipped; this folder is empty on purpose.
  const emptyHost = await mkdtemp(join(tmpdir(), 'fy-preview-host-'));
  let result: Awaited<ReturnType<typeof convert>>;
  try {
    result = await convert({
      from: staging,
      to: target,
      dryRun: false,
      lock: inputs.lock,
      now: inputs.now,
      host: { homeDirectory: emptyHost, env: {} },
      steps: stepPlan().run,
      preview: true,
    });
  } finally {
    await rm(emptyHost, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }

  const after = await snapshot(v4Home, home);
  const proof = compare(before, after);
  if (result.kind === 'refused')
    return {
      report: undefined,
      summary: `refused; nothing was written:\n${result.problems.map(p => `  - ${p}`).join('\n')}`,
      proof,
      changedWhileCopying: staged.changed,
      gate: [],
    };
  if (!result.report.complete) {
    await rm(target, { recursive: true, force: true });
    return {
      report: result.report,
      summary: `${summarise(result.report)}\nthe conversion did not finish; the unfinished home was removed`,
      proof,
      changedWhileCopying: staged.changed,
      gate: [],
    };
  }
  const gate = await gateFiles(target, v4Home, home);
  if (gate.length > 0) {
    await rm(target, { recursive: true, force: true });
    return {
      report: result.report,
      summary: `refused: the converted home names v4's home or a harness home in ${gate.length} file(s); it was removed:\n${gate.map(name => `  - ${name}`).join('\n')}`,
      proof,
      changedWhileCopying: staged.changed,
      gate,
    };
  }
  await writeFile(join(target, PREVIEW_MARKER), PREVIEW_MARKER_TEXT, { mode: 0o600 });
  return {
    report: result.report,
    summary: summarise(result.report),
    proof,
    changedWhileCopying: staged.changed,
    gate,
  };
}

/** Removes the preview home and its staging copy, and only a folder `prepare` marked. Returns what it removed. */
export async function cleanPreview(v4Home: string, target: string, home: string = homedir()): Promise<string> {
  const guarded = guardTarget(v4Home, target, home);
  if (!hasMarker(guarded.target))
    throw new Error(
      `${guarded.target} has no ${PREVIEW_MARKER} marker, so it is not a preview home; nothing was removed`,
    );
  await rm(guarded.target, { recursive: true, force: true });
  await rm(guarded.staging, { recursive: true, force: true });
  return `removed ${guarded.target}`;
}

/** Names the wrapper passes through from the caller's environment (and `LC_*`): nothing else reaches the binary. */
export const ENV_ALLOWLIST = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG', 'XDG_RUNTIME_DIR'] as const;

/** Daemon verbs the preview never runs through the product's lifecycle: they write claim files beside v4's unit. */
export const REFUSED_DAEMON_VERBS = ['stop', 'restart', 'update', 'install', 'uninstall', 'reset'] as const;

/** The one place a wrapper's text is made, so a test and the shell entry agree. */
export function wrapperText(home: string): string {
  if (/["$`\\\n]/u.test(home))
    throw new Error('the preview home must not contain a quote, $, backtick, backslash or newline');
  const url = `http://127.0.0.1:${PREVIEW.port}`;
  const refused = REFUSED_DAEMON_VERBS.map(verb => `daemon:${verb}`).join('|');
  return [
    '#!/bin/sh',
    "# fy5: the 5.0 preview CLI. Generated; it sets the preview home, port and address, never v4's.",
    'set -eu',
    `case "\${1:-}:\${2:-}" in`,
    `${refused})`,
    '  echo "fy5 does not run daemon lifecycle verbs: they write claim files beside v4\'s service unit." >&2',
    '  echo "Use the preview script instead: preview.sh start | stop | status | clean." >&2',
    '  exit 64',
    '  ;;',
    'esac',
    '# Nothing from a v4 ferret or the surrounding shell may reach the preview: the binary runs in an EMPTY environment',
    '# that holds only the allowlist below, and the preview home, port and address. FY_*, CLAUDE_*, CODEX_* never pass.',
    `set -- "${home}/bin/fy" "$@"`,
    `for name in ${ENV_ALLOWLIST.join(' ')} $(env | sed -n 's/^\\(LC_[A-Za-z0-9_]*\\)=.*/\\1/p'); do`,
    '  if eval "[ \\"\\${$name+set}\\" = set ]"; then',
    '    eval "value=\\${$name}"',
    '    set -- "$name=$value" "$@"',
    '  fi',
    'done',
    `exec env -i FY_HOME="${home}" FY_PORT="${PREVIEW.port}" FY_URL="${url}" "$@"`,
    '',
  ].join('\n');
}

export async function ensureFolder(path: string): Promise<void> {
  if ((await stat(path).catch(() => undefined)) === undefined) await mkdir(path, { recursive: true, mode: 0o700 });
}
