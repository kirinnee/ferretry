/**
 * Ticks every route row (`kind R`) of `docs/design/rebuild-parity.tsv` that descriptor-parity proves, and prints why
 * each other open one is not. Only a status cell that is exactly `[ ]` changes; `removed by design` and annotated
 * cells are left alone. Regenerate the markdown afterwards with `scripts/rebuild/parity.ts`.
 *
 *   bun scripts/rebuild/tick-routes.ts [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contextFor } from '../gen/lib/check.ts';
import { LEDGER, loadWorld, readLedger, routeProblem } from '../validate/parity-ticks.ts';

const root = join(import.meta.dir, '..', '..');
const ctx = contextFor(root);
const world = await loadWorld(root, ctx.model);
const text = readFileSync(join(root, LEDGER), 'utf8');
const rows = new Map(readLedger(text).map(r => [r.id, r]));
const open: string[] = [];
const reasons = new Map<string, number>();
let ticked = 0;
const lines = text.split('\n').map((line, index) => {
  if (index === 0) return line;
  const cells = line.split('\t');
  const row = rows.get(cells[0] ?? '');
  if (row === undefined || row.kind !== 'R' || cells[9] !== '[ ]') return line;
  const problem = routeProblem(row, world);
  if (problem === undefined) {
    ticked++;
    cells[8] = 'descriptor-parity';
    cells[9] = '[x]';
    return cells.join('\t');
  }
  open.push(`${row.id}\t${row.what}\t${problem}`);
  const kind =
    [
      'no single counterpart',
      'changed descriptor',
      'changed with no record',
      'route missing',
      'has no route',
      'removed in 5.0',
    ].find(k => problem.includes(k)) ?? problem;
  reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
  return line;
});
if (!process.argv.includes('--dry')) writeFileSync(join(root, LEDGER), lines.join('\n'));
for (const line of open) console.log(`open\t${line}`);
console.log(`ticked ${ticked}, left open ${open.length}`);
for (const [kind, n] of reasons) console.log(`  ${n}\t${kind}`);
