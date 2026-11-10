/**
 * The STRICT Appendix D count (merge-bar line 1), reported across every tier at once.
 *
 * Each test job judges only its own tier's JUnit report (`quick.sh`: `--tier unit`, `integration.sh`: `--tier int`), and
 * neither runs `--strict`, so nobody could see how many kept rows still lack an id-named test that PASSES in some run.
 * This reads the unit, scripts and integration reports together (no `--tier`: a passing test in EITHER tier proves a
 * row, a skipped or failed one does not) with `strict: true` (rows of still-pending packages count too), and writes the
 * miss count plus the ids grouped by owner to `$GITHUB_STEP_SUMMARY`.
 *
 * It is a report until the count reaches 0. `FY_STRICT_GUARANTEES_BLOCKING=true` (the one switch, set on the
 * `strict-guarantees` job in `.github/workflows/ci.yaml`) makes a miss exit 1; anything else exits 0.
 *
 * Usage: bun scripts/ci/strict-guarantees.ts --results <junit.xml|folder> [--results …] [--root <dir>]
 */
import { appendFileSync } from 'node:fs';
import { check } from '../validate/guarantees.ts';
import { contextFor, parseArgs } from '../gen/lib/check.ts';
import type { Finding } from '../gen/lib/graph.ts';

/** Findings with no owner in their sentence (a REMOVED row that kept a test) are listed under this heading. */
export const NO_OWNER = '(no owner)';

/** The owner a `guarantees` finding names: "<status> row owned by <owner> …". */
export const ownerOf = (finding: Finding): string => /\bowned by (\S+)/.exec(finding.message)?.[1] ?? NO_OWNER;

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

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const findings = await check.run(
    contextFor(args.root, { strict: true, ...(args.results === undefined ? {} : { results: args.results }) }),
  );
  const blocking = process.env.FY_STRICT_GUARANTEES_BLOCKING === 'true';
  const text = summary(findings, blocking);
  console.log(text);
  for (const finding of findings) console.log(`${finding.where}: ${finding.message}`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', text);
  process.exitCode = blocking && findings.length > 0 ? 1 : 0;
}
