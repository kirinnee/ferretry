import { join } from 'node:path';
import type { HousekeepingJob, HousekeepingSettings } from '../../../src/lib/housekeeping/protocol.ts';
import type { WindowTables } from '../../../src/lib/performance/recorder.ts';

const RUN = join(import.meta.dir, 'housekeeping-run.ts');

/** Everything one run of `housekeeping-run.ts` saw. */
export interface HousekeepingRun {
  readonly answers: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly consoled: readonly string[];
  readonly notices: readonly string[];
  readonly tables: WindowTables;
  /** The child's own stderr, which a leak could reach too. */
  readonly stderr: string;
}

/**
 * Runs `jobs` on the real housekeeping worker in a process whose `PATH` starts with `bin` — where a test
 * puts a fake `security` — and answers what it saw.
 */
export async function runHousekeepingProcess(
  spec: {
    readonly settings: HousekeepingSettings;
    readonly jobs: readonly HousekeepingJob[];
    readonly activity?: string;
  },
  bin: string,
): Promise<HousekeepingRun> {
  const child = Bun.spawn([process.execPath, RUN], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdin: new TextEncoder().encode(JSON.stringify(spec)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the housekeeping run exited ${String(code)}: ${stderr}`);
  return { ...(JSON.parse(stdout) as Omit<HousekeepingRun, 'stderr'>), stderr };
}
