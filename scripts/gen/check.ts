/**
 * `fy check` (§3.9, §7.9): runs the 5.0 checks over the workspace, sharing one model.
 *
 *   bun scripts/gen/check.ts                       every check
 *   bun scripts/gen/check.ts guarantees            the named checks only (`guarantees` also runs `guarantee-owner`)
 *   bun scripts/gen/check.ts --package projects    writes generated/package/projects/plugins.ts (that package's halves
 *                                                  + the contract fakes it consumes) and runs the checks that can be
 *                                                  scoped to one package, scoped to it
 *   --tests                                        then runs that package's own tests (one bun test process)
 *   --strict                                       `guarantees` also checks rows owned by pending packages
 *   --results <junit.xml|folder>                   `guarantees` reads whether a test passed (repeatable); --existence-only skips that
 *   --tier unit|int                                `guarantees` proves only the rows with a test in that tier (CI: one job per tier)
 *   --base <ref>                                   the ref `ports-pending.json` may not grow from
 *   --list                                         prints the checks and exits
 *
 * The `fy` shell calls this script for `fy check`; it exits 1 on any finding.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { check as actRunner } from '../validate/act-runner.ts';
import { check as appHooks } from '../validate/app-hooks.ts';
import { check as bannedGlobals } from '../validate/banned-globals.ts';
import { check as contextImports } from '../validate/context-imports.ts';
import { check as contractConsumes } from '../validate/contract-consumes.ts';
import { check as contractGraph } from '../validate/contract-graph.ts';
import { check as coreClosed } from '../validate/core-closed.ts';
import { check as descriptorParity } from '../validate/descriptor-parity.ts';
import { check as glossary } from '../validate/glossary.ts';
import { check as guarantees, ownerCheck as guaranteeOwner } from '../validate/guarantees.ts';
import { check as hostFiles } from '../validate/host-files.ts';
import { check as manifestMatch } from '../validate/manifest-match.ts';
import { check as noCompat } from '../validate/no-compat.ts';
import { check as oneFormat } from '../validate/one-format.ts';
import { check as pins } from '../validate/pins.ts';
import { check as privateFiles } from '../validate/private-files.ts';
import { check as pluginGraph } from '../validate/plugin-graph.ts';
import { check as portsPending } from '../validate/ports-pending.ts';
import { check as readScoped } from '../validate/read-scoped.ts';
import { check as registriesFresh } from '../validate/registries-fresh.ts';
import { check as screenPaths } from '../validate/screen-paths.ts';
import { check as shellProvides } from '../validate/shell-provides.ts';
import { check as words } from '../validate/words.ts';
import { type Check, type Finding, contextFor, parseArgs, report } from './lib/check.ts';
import { generatePackage, writeFiles } from './registries.ts';

/** Every §7.9 check, in the order the table lists them. */
export const CHECKS: readonly Check[] = [
  contextImports,
  contractConsumes,
  contractGraph,
  pluginGraph,
  appHooks,
  shellProvides,
  coreClosed,
  manifestMatch,
  screenPaths,
  portsPending,
  descriptorParity,
  readScoped,
  actRunner,
  bannedGlobals,
  hostFiles,
  registriesFresh,
  guarantees,
  guaranteeOwner,
  oneFormat,
  noCompat,
  words,
  glossary,
  pins,
  privateFiles,
];

/** Checks that read one package when `--package` is given; the rest are whole-graph and run unscoped. */
const SCOPED = new Set([
  'context-imports',
  'contract-consumes',
  'manifest-match',
  'app-hooks',
  'shell-provides',
  'screen-paths',
  'read-scoped',
  'act-runner',
  'banned-globals',
  'guarantees',
  'guarantee-owner',
  'one-format',
  'no-compat',
  'glossary',
  'private-files',
]);
const GRAPH = new Set(['plugin-graph', 'core-closed', 'contract-graph']);

/** Whether a finding is about this package: it is `where`, or a whole word of the message. */
export function namesPackage(finding: Finding, id: string): boolean {
  if (finding.where.split(/,\s*/).includes(id)) return true;
  return new RegExp(`(^|[^a-z0-9-])${id.replace(/-/g, '\\-')}($|[^a-z0-9-])`).test(finding.message);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv.filter(arg => arg !== '--tests' && arg !== '--list'));
  if (argv.includes('--list')) {
    for (const c of CHECKS) console.log(`${c.name.padEnd(20)} ${c.summary}`);
    return 0;
  }
  const names = new Set(args.rest);
  if (names.has('guarantees')) names.add('guarantee-owner');
  const unknown = [...names].filter(name => !CHECKS.some(c => c.name === name));
  if (unknown.length > 0) {
    console.error(`unknown check${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (see --list)`);
    return 2;
  }
  const ctx = contextFor(args.root, args);
  let selected = names.size > 0 ? CHECKS.filter(c => names.has(c.name)) : CHECKS;
  if (args.packageId !== undefined) {
    const model = await ctx.model();
    if (model.ws.byId(args.packageId) === undefined) {
      console.error(`no package with id "${args.packageId}"`);
      return 2;
    }
    writeFiles(model.ws.root, generatePackage(model, args.packageId));
    if (names.size === 0) selected = CHECKS.filter(c => SCOPED.has(c.name) || GRAPH.has(c.name));
  }
  const findings: Finding[] = [];
  for (const c of selected) {
    const all = await c.run(ctx);
    // In package mode a whole-graph check reports only what names this package (its edges, its cycle, its takes).
    const found =
      args.packageId !== undefined && GRAPH.has(c.name)
        ? all.filter(f => namesPackage(f, args.packageId as string))
        : all;
    findings.push(...found);
    if (found.length === 0) console.log(`✅ ${c.name}`);
  }
  let status = report('fy check', findings);
  if (status === 0 && args.packageId !== undefined && argv.includes('--tests')) {
    const pkg = (await ctx.model()).ws.byId(args.packageId);
    const tests = spawnSync('bun', ['test', join(pkg?.rel ?? '.', 'tests')], {
      cwd: args.root,
      stdio: 'inherit',
      timeout: 300_000,
    });
    status = tests.status === 0 ? 0 : 1;
  }
  return status;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
