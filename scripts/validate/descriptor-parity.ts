/**
 * `descriptor-parity` (§7.1, §7.9): a route, socket, member route or agent tool differs from today's table, until the
 * change is recorded with a reason. Today's table is `scripts/gen/today/routes.json`, extracted from the 4.x
 * reference checkout by `scripts/gen/today/extract.ts`. Deliberate changes are lines of
 * `scripts/validate/descriptor-parity-changes.tsv`: `table<TAB>key<TAB>change<TAB>reason`, where `change` is
 * `removed` (today has it, 5.0 does not), `added` (5.0 only) or `changed` (fields differ).
 *
 * Compared fields are today's descriptor, field for field: `minimum`, `caller`, `ferretDoor` (presence),
 * `privilegedOnly`, `unlockExempt`, `capability` (name, axis, narrowing), `consultsGrants`, `wardenRemedy`,
 * `noStore`, `compress`, `precedence`, `available` (presence), and for member routes `member` and `catalog`. An agent
 * tool is compared by presence only: today it is an MCP wrapper in `fy` with no descriptor of its own. The new
 * `audit` and `guard` fields have no counterpart today and are not compared. A field today's extractor could not
 * resolve (`unresolved:…`) is not compared and is counted in the output.
 *
 *   bun scripts/validate/descriptor-parity.ts [--report]   (--report prints every difference as a table and exits 0)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DescriptorRow, parity, rowsOf } from '../../packages/core/kernel/testing/parity.ts';
import { type Check, runMain } from '../gen/lib/check.ts';

export { COMPARED, type DescriptorRow, parity, rowsOf } from '../../packages/core/kernel/testing/parity.ts';

export const TODAY_ROUTES = 'scripts/gen/today/routes.json';
export const PARITY_CHANGES = 'scripts/validate/descriptor-parity-changes.tsv';

export function readChanges(text: string): Map<string, { change: string; reason: string }> {
  const out = new Map<string, { change: string; reason: string }>();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const [table, key, change, reason] = line.split('\t');
    if (
      table === undefined ||
      key === undefined ||
      change === undefined ||
      reason === undefined ||
      reason.trim() === ''
    )
      throw new Error(`${PARITY_CHANGES}: "${line}" is not table<TAB>key<TAB>change<TAB>reason`);
    out.set(`${table}\t${key}`, { change, reason });
  }
  return out;
}

export const check: Check = {
  name: 'descriptor-parity',
  summary: "every route, socket and tool matches today's descriptor or records why not",
  async run(ctx) {
    const fixture = join(ctx.root, TODAY_ROUTES);
    if (!existsSync(fixture))
      return [
        {
          check: 'descriptor-parity',
          where: TODAY_ROUTES,
          message: "today's table is missing; run scripts/gen/today/extract.ts",
        },
      ];
    const today = (JSON.parse(readFileSync(fixture, 'utf8')) as { rows: DescriptorRow[] }).rows;
    const changesFile = join(ctx.root, PARITY_CHANGES);
    const changes = existsSync(changesFile) ? readChanges(readFileSync(changesFile, 'utf8')) : new Map();
    const model = await ctx.model();
    const next = model.loaded.flatMap(s => rowsOf(s.manifest));
    const result = parity(today, next, changes);
    if (result.unresolved > 0)
      console.error(`descriptor-parity: ${result.unresolved} unresolved field(s) in today's table were not compared`);
    if (process.argv.includes('--report')) {
      for (const finding of result.findings) console.log(`${finding.where}\t${finding.message}`);
      return [];
    }
    return result.findings;
  },
};

if (import.meta.main)
  await runMain(
    check,
    process.argv.slice(2).filter(arg => arg !== '--report'),
  );
