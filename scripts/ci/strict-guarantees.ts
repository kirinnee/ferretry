/**
 * The STRICT Appendix D count (merge-bar line 1), reported across every tier at once.
 *
 * Each test job judges only its own tier's JUnit report (`quick.sh`: `--tier unit`, `integration.sh`: `--tier int`), and
 * neither runs `--strict`, so nobody could see how many kept rows still lack an id-named test that PASSES in some run.
 * This reads the unit, scripts and integration reports together (no `--tier`: a passing test in EITHER tier proves a
 * row, a skipped or failed one does not) with `strict: true` (rows of still-pending packages count too), and writes the
 * miss count plus the ids grouped by owner to `$GITHUB_STEP_SUMMARY`. The count is every finding of `guarantees` and of
 * `guarantee-owner` (enforcer symbols included); a row with several findings is one row in the count.
 *
 * It was a report until the count reached 0 and is blocking now. `FY_STRICT_GUARANTEES_BLOCKING=true` (the one switch,
 * the workflow-level `env` of `.github/workflows/ci.yaml`) makes a miss exit 1; anything else exits 0 and only reports.
 *
 * Usage: bun scripts/ci/strict-guarantees.ts --results <junit.xml|folder> [--results …] [--root <dir>]
 */
import { appendFileSync } from 'node:fs';
import { check, ownerCheck } from '../validate/guarantees.ts';
import { type CheckContext, contextFor, parseArgs } from '../gen/lib/check.ts';
import type { Finding } from '../gen/lib/graph.ts';

/** Findings with no owner in their sentence (a REMOVED row that kept a test) are listed under this heading. */
export const NO_OWNER = '(no owner)';

/**
 * The owner a finding names: "<status> row owned by <owner> …" (`guarantees`, and `guarantee-owner`'s "tested only
 * outside"), "enforcer `x` resolves to no symbol in <owner> or a contract …" or `owner "<owner>" is no package`
 * (`guarantee-owner`'s other two).
 */
export const ownerOf = (finding: Finding): string =>
  /\bowned by (\S+)/.exec(finding.message)?.[1] ??
  /\bresolves to no symbol in (\S+) or a contract\b/.exec(finding.message)?.[1] ??
  /^owner "([^"]+)" is no package/.exec(finding.message)?.[1] ??
  NO_OWNER;

/** The misses grouped by owner (owners and ids in sorted order, one id once). */
export function byOwner(findings: readonly Finding[]): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const finding of findings) {
    const owner = ownerOf(finding);
    groups.set(owner, (groups.get(owner) ?? new Set()).add(finding.where));
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([owner, ids]) => [owner, [...ids].sort()]));
}

/** The `$GITHUB_STEP_SUMMARY` markdown: the count first, then one line per owner. */
export function summary(findings: readonly Finding[], blocking: boolean): string {
  // "No JUnit report found" is not a missing row: the count would be unknowable, so say that instead of a number.
  const noReport = findings.some(finding => finding.where === 'results');
  const groups = byOwner(findings.filter(finding => finding.where !== 'results'));
  const count = [...groups.values()].reduce((sum, ids) => sum + ids.length, 0);
  const mode = blocking
    ? 'BLOCKING'
    : 'report only; flip `FY_STRICT_GUARANTEES_BLOCKING` in ci.yaml when the count is 0';
  const lines = [
    `### Strict Appendix D guarantees: ${noReport ? 'unknown, no JUnit report found' : `${count} missing`} (${mode})`,
    '',
  ];
  if (noReport) lines.push('No JUnit report was downloaded, so no test is proven to pass.');
  else if (count === 0)
    lines.push('Every kept row has an id-named test that passed in the unit, scripts or integration reports.');
  else {
    lines.push('| Owner | Missing | Ids |', '| --- | ---: | --- |');
    for (const [owner, ids] of groups) lines.push(`| ${owner} | ${ids.length} | ${ids.join(' ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The strict findings: EVERY finding of `guarantees --strict` (no id test, or none that passed) and of
 * `guarantee-owner --strict` (a row tested only outside its owner's suite, an owner that is no package, and an enforcer
 * symbol that resolves to nothing in the owner or a contract it consumes), over all the reports at once and with no
 * tier. This is exactly what the two checks raise once `--strict` is on in `quick.sh` and `integration.sh`, so a count
 * of 0 here means the flip changes nothing: no check is filtered, so the count cannot be lower than the gate's. A row
 * proven in the integration tier alone still passes, because no tier narrows the tests or the results.
 */
export async function strictFindings(ctx: CheckContext): Promise<readonly Finding[]> {
  return [...(await check.run(ctx)), ...(await ownerCheck.run(ctx))];
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const findings = await strictFindings(
    contextFor(args.root, { strict: true, ...(args.results === undefined ? {} : { results: args.results }) }),
  );
  const blocking = process.env.FY_STRICT_GUARANTEES_BLOCKING === 'true';
  const text = summary(findings, blocking);
  console.log(text);
  for (const finding of findings) console.log(`${finding.where}: ${finding.message}`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', text);
  process.exitCode = blocking && findings.length > 0 ? 1 : 0;
}
