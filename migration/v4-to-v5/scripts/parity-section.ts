/**
 * Writes the "Migration" section of `docs/design/rebuild-parity.md` (lead decision 2026-11-07: the converter owns it)
 * from this tool's own step table and a conversion report, so the rows can never drift from the code.
 *
 *   bun scripts/parity-section.ts <conversion-report.json>
 *
 * Use the report of CI's run on the v4 fixture home (workflow `Migration v4 to v5`, artifact `report.json`). Then, from
 * the repository root: `bun scripts/rebuild/parity.ts --source ../rebuild-ref` (it includes this file verbatim) and
 * `nix fmt -- docs/design/rebuild-parity-migration.md docs/design/rebuild-parity.md`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STEPS } from '../src/steps/index.ts';

const reportPath = process.argv[2];
if (reportPath === undefined) {
  console.error('usage: bun scripts/parity-section.ts <conversion-report.json>');
  process.exit(64);
}
const tool = join(import.meta.dir, '..');
const target = join(tool, '../../docs/design/rebuild-parity-migration.md');

const report = JSON.parse(await Bun.file(reportPath).text()) as
  | { steps: { id: string; status: string }[] }
  | { id: string; status: string }[];
const steps = Array.isArray(report) ? report : report.steps;
const status = new Map(steps.map(step => [step.id, step.status]));

/** The step's own test file, when it has one. */
const TEST_FILE: Readonly<Record<string, string>> = { asks: 'agenda', vault: 'secrets', identity: 'secrets' };
const testFor = (id: string): string => {
  const file = `tests/unit/${TEST_FILE[id] ?? id}.test.ts`;
  return existsSync(join(tool, file)) ? `\`migration/v4-to-v5/${file}\`` : '—';
};
const cell = (text: string): string => text.replaceAll('|', '\\|');
const statusCell = (state: string | undefined): string =>
  state === 'converted'
    ? '[x] converted'
    : state === 'pending'
      ? '[ ] waits for its v5 schema'
      : `[ ] ${state ?? 'not run'}`;

const rows = STEPS.map(
  step =>
    `| M-${step.id} | ${cell(step.title)} | ${cell(step.owner.join(', '))} | ${
      step.sealed.length > 0 ? `${String(step.sealed.length)} sealed` : '—'
    } | ${String(step.notCarried.length)} | ${testFor(step.id)} | ${statusCell(status.get(step.id))} |`,
);

await Bun.write(
  target,
  `## Migration (v4 → v5 home conversion)

The one-time converter at \`migration/v4-to-v5/\` (outside the product: \`scripts/validate/migration-isolated.sh\`) carries a
stopped v4.291.x home into a new v5 home; the run book is \`docs/migration/v4-to-v5-prompt.md\` and every v4 file is in
\`docs/migration/v4-formats.md\`. One row per conversion step, in the converter's order, written by
\`migration/v4-to-v5/scripts/parity-section.ts\`. "Sealed" files move byte for byte and are never opened; "not carried"
counts the items the step lists with a reason. Status is from CI's run on a v4 home built with the real 4.291.5 release
binaries (workflow \`Migration v4 to v5\`); a step that waits leaves no \`home.json\`, so v5 refuses the folder until every
row is converted.

| Row | Step | v5 owner | Sealed | Not carried | Test | Status |
| --- | --- | --- | --- | ---: | --- | --- |
${rows.join('\n')}
`,
);
console.log(`wrote ${target}`);
