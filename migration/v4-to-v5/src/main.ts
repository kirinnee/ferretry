/**
 * bun migration/v4-to-v5/src/main.ts --from <stopped v4 home> --to <new folder> [--report <file>] [--dry-run] [--drop-uncarried]
 *
 * `--drop-uncarried` is the person's explicit choice (never a default, and an agent never passes it without the owner's
 * yes): a profile layer naming a settings or hooks component this tool cannot carry is removed instead of leaving the
 * Settings step pending, so the ferrets on those profiles may be LESS restricted than in v4. Each is named in the report.
 *
 * Exit 0: complete (home.json written). 3: ran, but some step is pending or failed (no home.json; v5 refuses the
 * folder). 2: refused before writing anything. 64: usage. A dry run writes nothing (its report says `complete: false`)
 * and exits 0 when every step WOULD convert, 3 when one would not.
 */
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { convert } from './convert.ts';
import { hostLockProbe } from './preflight.ts';
import { summarise } from './report.ts';

const USAGE =
  'usage: bun src/main.ts --from <stopped v4 home> --to <new v5 home> [--report <file>] [--dry-run] [--drop-uncarried]';

async function main(argv: readonly string[]): Promise<number> {
  let values: { from?: string; to?: string; report?: string; 'dry-run'?: boolean; 'drop-uncarried'?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        report: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'drop-uncarried': { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 64;
  }
  if (values.from === undefined || values.to === undefined) {
    console.error(USAGE);
    return 64;
  }
  const from = resolve(values.from);
  const to = resolve(values.to);
  const dryRun = values['dry-run'] ?? false;
  const result = await convert({
    from,
    to,
    dryRun,
    lock: hostLockProbe(),
    now: () => new Date(),
    ...(values['drop-uncarried'] === true ? { dropUncarried: true } : {}),
    host: {
      homeDirectory: homedir(),
      ...(process.env.XDG_CONFIG_HOME === undefined ? {} : { configHome: process.env.XDG_CONFIG_HOME }),
      env: process.env,
    },
  });
  if (result.kind === 'refused') {
    console.error(`refused; nothing was written:\n${result.problems.map(p => `  - ${p}`).join('\n')}`);
    return 2;
  }
  // The report sits BESIDE the new home, never inside it: a v5 home holds only declared files.
  const reportPath = resolve(values.report ?? `${to}.conversion-report.json`);
  await writeFile(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, { mode: 0o600 });
  console.log(summarise(result.report));
  console.log(`report: ${reportPath}`);
  const wouldComplete = result.report.steps.every(step => step.status === 'converted');
  return (dryRun ? wouldComplete : result.report.complete) ? 0 : 3;
}

process.exit(await main(process.argv.slice(2)));
