/**
 * The preview's two programs: `dryRun` says what a run would do and touches nothing; `prepare` makes the preview
 * home from a v4 home and proves v4 was left alone. Neither starts a daemon. Every path is a parameter so a test
 * runs both in temp folders.
 */
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert } from '../src/convert.ts';
import type { LockProbe } from '../src/preflight.ts';
import { type ConversionReport, summarise } from '../src/report.ts';
import { ALLOWED, LEFT_BEHIND, PREVIEW, SESSION_FILES, stepPlan } from './plan.ts';
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
}

export interface Prepared {
  readonly report: ConversionReport | undefined;
  readonly summary: string;
  readonly proof: Verdict;
  readonly changedWhileCopying: readonly string[];
}

/** Stage, convert, delete the staging copy, prove v4 unchanged. Refuses a target that exists and is not empty. */
export async function prepare(inputs: PrepareInputs): Promise<Prepared> {
  const { v4Home, target } = inputs;
  const existing = await readdir(target).catch(() => undefined);
  if (existing !== undefined && existing.length > 0)
    throw new Error(`${target} is not empty; the preview is made once. Run clean first.`);

  const before = await snapshot(v4Home);
  const staging = stagingFor(target);
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
    });
  } finally {
    await rm(emptyHost, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }

  const after = await snapshot(v4Home);
  const proof = compare(before, after);
  if (result.kind === 'refused')
    return {
      report: undefined,
      summary: `refused; nothing was written:\n${result.problems.map(p => `  - ${p}`).join('\n')}`,
      proof,
      changedWhileCopying: staged.changed,
    };
  return { report: result.report, summary: summarise(result.report), proof, changedWhileCopying: staged.changed };
}

/** The one place a wrapper's text is made, so a test and the shell entry agree. */
export function wrapperText(home: string): string {
  const url = `http://127.0.0.1:${PREVIEW.port}`;
  return [
    '#!/bin/sh',
    "# fy5: the 5.0 preview CLI. Generated; it sets the preview home, port and address, never v4's.",
    'set -eu',
    `export FY_HOME="${home}"`,
    `export FY_PORT="${PREVIEW.port}"`,
    `export FY_URL="${url}"`,
    '# Nothing from a v4 ferret or a surrounding terminal multiplexer may leak into the preview.',
    'unset FY_TOKEN TMUX TMUX_PANE',
    `exec "${home}/bin/fy" "$@"`,
    '',
  ].join('\n');
}

export async function ensureFolder(path: string): Promise<void> {
  if ((await stat(path).catch(() => undefined)) === undefined) await mkdir(path, { recursive: true, mode: 0o700 });
}
