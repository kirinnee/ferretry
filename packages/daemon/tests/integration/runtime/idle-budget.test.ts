/**
 * WHAT AN IDLE DAEMON MAY COST, HELD IN CI.
 *
 * Boots a REAL `fyd` over the owner-scale fleet — 36 sessions, 5 of them running in REAL tmux panes on
 * the daemon's private socket, 2,000 Codex rollouts, six runtime homes — lets its boot and first
 * housekeeping settle, and then profiles it with its own `/v1/diagnostics/profile` while nobody touches
 * it. The build fails when the idle daemon spends more than its ceiling on any measure, and the failure
 * prints the report's own ranking, so it names the code to fix.
 *
 * TWO NUMBERS PER MEASURE. The product's TARGET (`IDLE_DAEMON_BUDGETS`, printed in every
 * `fy daemon profile`) is where the event-driven daemon must land (docs/design/event-driven-daemon.md).
 * The CEILING below is what CI holds today: the measured cost of the current daemon with headroom for
 * a noisy runner. Every perf PR that lowers a cost lowers its ceiling in the same commit, and the
 * ceilings may only move DOWN — towards the targets — so a regression fails the build the day it lands.
 *
 * The transcripts are 8 MiB rather than 200 MB: their size drives boot work (held by
 * `boot-stalls.test.ts`), not idle work, and CI should not write 600 MB to measure nothing.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PerformanceProfileView, PerformanceReport } from '@ferretry/protocol';
import should from 'should';
import { IDLE_DAEMON_BUDGETS } from '../../../src/lib/performance/budgets.ts';
import { freeLoopbackPort } from '../support/booted-daemon.ts';
import { ANTHROPIC_USAGE_PATH, CODEX_USAGE_PATH, startFakeUsageServer } from '../support/fake-usage-server.ts';
import { startFleetPanes } from '../support/fleet-panes.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { OWNER_MAC_FLEET, scaledFleet, sessionIdOf } from '../support/scaled-fleet.ts';

const FYD_ENTRY = resolve(import.meta.dir, '../../../bin/fyd.ts');
const SETTLE_SECONDS = 15;
/** Half a minute: at the fixture's 10 s usage interval, at least two fleet passes land inside it. */
const PROFILE_SECONDS = 30;

/**
 * CI's ceilings — the ratchet. Each step records what this fixture measured when it was lowered.
 *
 * - First set (#694, 4.66.3): CPU 20% of a core, 660 child processes/min (all tmux and ps), 3,441
 *   read/write system calls/s, longest loop block 17 ms, 17 state-port file operations/s.
 * - Lowered after #693 (document cache), #696 (tmux control mode), #697 (Codex discovery pacing) and
 *   #698 (file-event hub): CPU 15.5%, 0 child processes/min, 1,472 read/write system calls/s, longest
 *   block 5 ms, 9 state-port file operations/s.
 * - Lowered after the Codex discovery window was anchored to each session's start
 *   (perf/codex-eager-window): measured locally, CPU 6% and 135 read/write system calls/s; the CI
 *   ceilings keep headroom over the CI figures above.
 *
 * Lower a number here in the PR that earns it; never raise one.
 */
const CEILINGS: Readonly<Record<string, number>> = {
  'daemon CPU': 25,
  'child processes': 30,
  'longest event-loop block': 100,
  'file operations through the daemon’s ports': 100,
  'read/write system calls': 2_500,
};

/**
 * A main-thread frame that observes a session: a transcript read or parse, or a pane capture. Since stage 3d
 * (docs/design/session-workers.md) each running session is observed on its own worker, and an idle main
 * thread runs none of it — a document's own schema parse (zod) is not one of these.
 */
const OBSERVATION_FRAME = /transcript|Parser\b|parser\.ts|capture|pane-frames|PaneFrames/i;

/** The report's own ranking, cut to what names the code to fix. */
function ranking(report: PerformanceReport) {
  return {
    cpu: report.resources.cpu,
    childProcesses: report.childProcesses.commands
      .slice(0, 6)
      .map(
        entry =>
          `${String(entry.perMinute)}/min ${entry.command} by ${(entry.by ?? []).map(starter => `${starter.activity} ${String(starter.count)}`).join(', ')}`,
      ),
    hotFunctions: report.cpuProfile.self.slice(0, 8).map(entry => `${String(entry.share)} ${entry.frame}`),
    activities: report.activities
      .slice(0, 6)
      .map(entry => `${entry.name} ${String(entry.perMinute)}/min p95 ${String(entry.wall.p95Ms)} ms`),
    stalls: report.eventLoop.stalls.slice(0, 3),
  };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('an idle daemon on a fleet the size of the owner’s Mac', () => {
  it('should stay under every CI ceiling while nobody touches it', async () => {
    // Arrange — the fleet, a real pane per running session, a real daemon in its own process.
    const fleet = await scaledFleet(await tempDirectory('fyd-idle-budget-'), {
      ...OWNER_MAC_FLEET,
      running: 5,
      hugeTranscriptBytes: 8 * 1024 * 1024,
      transcriptBytes: 1024 * 1024,
    });
    const sessions: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const config = JSON.parse(
        await readFile(join(fleet.home, 'state', 'sessions', sessionIdOf(index), 'config.json'), 'utf8'),
      ) as { tmuxSession: string };
      sessions.push(config.tmuxSession);
    }
    const panes = await startFleetPanes(fleet.home, sessions);
    // The providers' free usage reads, answered on this machine: the fixture's logins are real stores.
    const usage = startFakeUsageServer();
    const port = await freeLoopbackPort();
    await mkdir(join(fleet.home, 'config'), { recursive: true });
    await writeFile(
      join(fleet.home, 'config', 'daemon.json'),
      JSON.stringify({ host: '127.0.0.1', port, relay: { url: 'ws://127.0.0.1:9', enabled: false } }),
    );
    const daemon = Bun.spawn([process.execPath, FYD_ENTRY], {
      env: {
        ...process.env,
        FY_HOME: fleet.home,
        HOME: fleet.userHome,
        FYD_BACKGROUND_DELAY_SECONDS: '1',
        FYD_WATCHDOG_SECONDS: '0',
        FY_USAGE_PROBE_ORIGIN: usage.origin,
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: Bun.file(join(fleet.home, 'fyd.err')),
    });
    const base = `http://127.0.0.1:${String(port)}`;
    let report: PerformanceReport | undefined;
    try {
      for (let attempt = 0; (await fetch(`${base}/healthz`).catch(() => undefined))?.ok !== true; attempt += 1) {
        if (attempt > 600)
          throw new Error(`the daemon never answered: ${await readFile(join(fleet.home, 'fyd.err'), 'utf8')}`);
        await Bun.sleep(100);
      }
      await Bun.sleep(SETTLE_SECONDS * 1_000);
      const token = (await readFile(join(fleet.home, 'api-token'), 'utf8')).trim();
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

      // Act — the daemon profiles itself while idle.
      const started = await fetch(`${base}/v1/diagnostics/profile`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ seconds: PROFILE_SECONDS }),
      });
      should(started.status).equal(202);
      const { id } = (await started.json()) as PerformanceProfileView;
      await Bun.sleep(PROFILE_SECONDS * 1_000);
      for (let attempt = 0; attempt < 30 && report === undefined; attempt += 1) {
        const view = (await (
          await fetch(`${base}/v1/diagnostics/profile/${id}`, { headers })
        ).json()) as PerformanceProfileView;
        if (view.state === 'finished') report = view.report;
        else await Bun.sleep(500);
      }
    } finally {
      daemon.kill();
      await daemon.exited;
      await panes.close();
      await usage.stop();
    }

    // Assert — every measure the report could see, against its ceiling; a failure prints the ranking.
    if (report === undefined) throw new Error('the profile never finished');
    should(report.fleet).deepEqual({ sessions: 36, running: 5 });
    // The budget sees stage 4: the usage pass ran inside the window and read every login.
    const fleetRefresh = report.activities.find(activity => activity.name === 'fleet refresh');
    should(fleetRefresh?.count ?? 0).be.aboveOrEqual(2);
    should(usage.hits.get(ANTHROPIC_USAGE_PATH) ?? 0).be.aboveOrEqual(2);
    should(usage.hits.get(CODEX_USAGE_PATH) ?? 0).be.aboveOrEqual(1);
    // What CI measured, so the next PR that earns a lower ceiling can read it from the log.
    console.log(`idle budgets: ${report.budgets.map(budget => `${budget.name} ${String(budget.actual)}`).join('; ')}`);
    const observing = [...report.cpuProfile.self, ...report.cpuProfile.inclusive]
      .map(entry => entry.frame)
      .filter(frame => OBSERVATION_FRAME.test(frame));
    if (observing.length > 0)
      throw new Error(
        `the idle main thread observed a session itself: ${observing.join('; ')}\n\n${JSON.stringify(ranking(report), null, 2)}`,
      );
    const over = report.budgets.filter(budget => budget.actual > (CEILINGS[budget.name] ?? budget.limit));
    if (over.length > 0)
      throw new Error(
        `over the CI ceiling: ${over.map(budget => `${budget.name} ${String(budget.actual)} > ${String(CEILINGS[budget.name])}`).join('; ')}\n\n${JSON.stringify(ranking(report), null, 2)}`,
      );
    // Every ceiling is a real measure of the report, and none is looser than nothing at all.
    should(Object.keys(CEILINGS).sort()).deepEqual(IDLE_DAEMON_BUDGETS.map(budget => budget.name).sort());
    for (const budget of IDLE_DAEMON_BUDGETS) should(CEILINGS[budget.name]).be.aboveOrEqual(budget.limit);
  }, 240_000);
});
