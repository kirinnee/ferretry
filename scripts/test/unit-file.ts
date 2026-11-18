#!/usr/bin/env bun
/**
 * Runs ONE test file under the unit config, and says so plainly when the file is not a unit test.
 *
 * Usage: `bun scripts/test/unit-file.ts <file> [bun test options...]` (or `task test:unit:file -- <file>`).
 *
 * WHY. `bun test --config=bunfig.unit.toml <file>` on a file the unit config leaves out (a perf or integration test,
 * a `scripts/` test, a tool package's tests) prints Bun's "filters did not match any test files" and EXITS 1,
 * which reads as a failing test (it was taken for one, twice) when the file simply runs under another runner and passes
 * there. So the decision is made here, from the bunfigs themselves (`root` and `pathIgnorePatterns`), never from a copy
 * of their patterns:
 *
 *   - IN the unit config: Bun runs it, and its exit is ours. A configured file that runs ZERO tests exits 1 too (Bun
 *     itself exits 0 for it): the file was asked for and nothing ran, which is a failure, never a pass.
 *   - NOT in it, but another config claims it (integration, SIT, realworld, perf, `scripts/`, a tool package):
 *     print "not in this config" and the command that runs it, exit 0. Nothing is run.
 *   - claimed by NO runner: exit 1. That file would run in no job at all, which is a hole, not an "ok".
 *
 * Where each tier runs in CI is docs/standards/ci-cd (job per tier); this script only names the local command.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

type Tier = { name: string; config: string; command: string };
type Bunfig = { test?: { root?: string; pathIgnorePatterns?: string[] } };

/** The tiers a file under `packages/` can belong to, with the command that runs ONE of its files. */
export const TIERS: readonly Tier[] = [
  { name: 'unit', config: 'bunfig.unit.toml', command: 'bun test --config=bunfig.unit.toml' },
  { name: 'integration', config: 'bunfig.int.toml', command: 'bun test --config=bunfig.int.toml --timeout 120000' },
  {
    name: 'SIT',
    config: 'bunfig.sit.toml',
    command: 'SIT_DRIVER=inprocess bun test --config=bunfig.sit.toml --timeout 120000',
  },
  {
    name: 'realworld',
    config: 'bunfig.realworld.toml',
    command: 'bun test --config=bunfig.realworld.toml --timeout 120000',
  },
  { name: 'perf', config: 'bunfig.perf.toml', command: 'bun test --config=bunfig.perf.toml --timeout 120000' },
];

const TEST_NAME = /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/u;

/** True when `file` (repo-relative, no leading `./`) is one the bunfig's `root` and `pathIgnorePatterns` leave in. */
export const configHolds = (root: string, config: string, file: string): boolean => {
  const test = (Bun.TOML.parse(readFileSync(join(root, config), 'utf8')) as Bunfig).test ?? {};
  const base = test.root ?? '.';
  if (base !== '.' && !file.startsWith(`${base}/`)) return false;
  if (!TEST_NAME.test(file)) return false;
  return !(test.pathIgnorePatterns ?? []).some(pattern => new Bun.Glob(pattern).match(file));
};

export type Plan =
  | { kind: 'run'; file: string }
  | { kind: 'elsewhere'; file: string; where: string; command: string }
  | { kind: 'unclaimed'; file: string };

/** What to do with one repo-relative file. Pure over the bunfigs under `root`. */
export const planFor = (root: string, file: string): Plan => {
  if (configHolds(root, TIERS[0]!.config, file)) return { kind: 'run', file };
  for (const tier of TIERS.slice(1)) {
    if (configHolds(root, tier.config, file))
      return {
        kind: 'elsewhere',
        file,
        where: `${/^[aeiou]/iu.test(tier.name) ? 'an' : 'a'} ${tier.name} test`,
        command: `${tier.command} ${file}`,
      };
  }
  // Outside the bunfigs' `packages` root: the repository tooling's tests run in Quick's `scripts` part, with no config.
  if (file.startsWith('scripts/') && TEST_NAME.test(file))
    return {
      kind: 'elsewhere',
      file,
      where: "a repository-tooling test (Quick's `scripts` part)",
      command: `bun test ./${file}`,
    };
  // A tool beside the product that is a package of its own (its own package.json, so its own dependencies and its own
  // workflow): its tests run from its own folder.
  for (let dir = dirname(file); dir !== '.' && !dir.startsWith('packages'); dir = dirname(dir)) {
    if (!existsSync(join(root, dir, 'package.json'))) continue;
    if (TEST_NAME.test(file))
      return {
        kind: 'elsewhere',
        file,
        where: `a test of the package in ${dir}/ (its own dependencies and workflow)`,
        command: `cd ${dir} && bun install --frozen-lockfile && bun test ${relative(dir, file)}`,
      };
    break;
  }
  return { kind: 'unclaimed', file };
};

/** The sentence a not-in-this-config file gets. */
export const elsewhereMessage = (plan: Extract<Plan, { kind: 'elsewhere' }>): string =>
  `ℹ️ ${plan.file} is not in this config (bunfig.unit.toml): it is ${plan.where}, so the unit runner does not run it.\n` +
  `   Run it with: ${plan.command}\n` +
  '   Nothing was run, and that is not a failure.';

/** Bun exits 0 for a configured file that registers no test; this run was asked for one file, so that is a failure. */
export const ranNoTests = (output: string): boolean => /\bRan 0 tests across\b/u.test(output);

const main = async (): Promise<number> => {
  const root = resolve(process.env.FY_UNIT_FILE_ROOT ?? join(import.meta.dir, '..', '..'));
  const [target, ...bunArgs] = process.argv.slice(2);
  if (target === undefined || target.startsWith('-')) {
    console.error('usage: unit-file.ts <test-file> [bun test options...]');
    return 2;
  }
  const absolute = isAbsolute(target) ? target : resolve(process.cwd(), target);
  const file = relative(root, absolute);
  if (file.startsWith('..') || !existsSync(absolute)) {
    console.error(`❌ ${target}: no such file under ${root}`);
    return 2;
  }
  const plan = planFor(root, file);
  if (plan.kind === 'elsewhere') {
    console.log(elsewhereMessage(plan));
    return 0;
  }
  if (plan.kind === 'unclaimed') {
    console.error(
      `❌ ${file} is claimed by no test config (not packages/**/tests/<tier>/, scripts/ or a tool package): no job would run it`,
    );
    return 1;
  }
  const child = Bun.spawn([process.execPath, 'test', '--config=bunfig.unit.toml', file, ...bunArgs], {
    cwd: root,
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const seen: string[] = [];
  const mirror = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      seen.push(text);
      sink.write(text);
    }
  };
  await Promise.all([mirror(child.stdout, process.stdout), mirror(child.stderr, process.stderr)]);
  const status = await child.exited;
  if (status === 0 && ranNoTests(seen.join(''))) {
    console.error(`❌ ${file} is in the unit config but ran 0 tests`);
    return 1;
  }
  return status;
};

if (import.meta.main) process.exit(await main());
