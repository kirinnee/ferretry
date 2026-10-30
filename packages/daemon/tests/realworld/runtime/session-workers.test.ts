/**
 * Asserts a rate over a timed window; the outcome depends on the machine, not the code.
 *
 * ONE THREAD PER RUNNING SESSION, IN A REAL DAEMON — pooled and dedicated.
 *
 * Boots a real `fyd` from source over a small fleet with REAL tmux panes for its running sessions, and asks
 * the daemon's own profile what ran: each running session is looked at by its worker — the profile's
 * workers table names the session observer and its activity table counts the workers' looks, reported
 * across the thread boundary — and only when something happened. It runs once with a thread per session
 * and once with every session pooled on one, because the default cap is the owner's to choose.
 *
 * THE MEASURED WINDOW STARTS ONCE THE DAEMON IS QUIET. Each worker's first look is at attach, and on a
 * loaded host attach can land inside the window: so short profiles are taken until one sees no look at
 * all, and only then is the pane drawn on and counted.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PerformanceProfileView, PerformanceReport } from '@ferretry/protocol';
import should from 'should';
import { OS_CHOSEN_PORT, recordedPort } from '../../integration/support/os-port.ts';
import { cleanupTempDirectories, tempDirectory } from '../../integration/support/repository.ts';
import { scaledFleet, sessionIdOf } from '../../integration/support/scaled-fleet.ts';

const FYD_ENTRY = resolve(import.meta.dir, '../../../bin/fyd.ts');
const RUNNING = 2;

afterAll(async () => {
  await cleanupTempDirectories();
});

async function profiled(sessionWorkers: Record<string, unknown>): Promise<PerformanceReport> {
  const fleet = await scaledFleet(await tempDirectory('fyd-session-workers-'), {
    sessions: 4,
    running: RUNNING,
    hugeTranscripts: 0,
    hugeTranscriptBytes: 0,
    transcriptBytes: 64 * 1024,
    rollouts: 4,
    rolloutBytes: 4 * 1024,
    undiscoveredCodex: 0,
  });
  const socket = join(fleet.home, 'tmux.sock');
  const tmux = (args: readonly string[]) => Bun.spawnSync(['tmux', '-u', '-S', socket, ...args]);
  const panes: string[] = [];
  for (let index = 0; index < RUNNING; index += 1) {
    const config = JSON.parse(
      await readFile(join(fleet.home, 'state', 'sessions', sessionIdOf(index), 'config.json'), 'utf8'),
    ) as { tmuxSession: string };
    panes.push(config.tmuxSession);
    should(tmux(['new-session', '-d', '-s', config.tmuxSession, '-x', '120', '-y', '30', 'sleep 3600']).exitCode).equal(
      0,
    );
  }
  await mkdir(join(fleet.home, 'config'), { recursive: true });
  await writeFile(
    join(fleet.home, 'config', 'daemon.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port: OS_CHOSEN_PORT,
      relay: { url: 'ws://127.0.0.1:9', enabled: false },
      sessionWorkers,
    }),
  );
  const daemon = Bun.spawn([process.execPath, FYD_ENTRY], {
    env: { ...process.env, FY_HOME: fleet.home, HOME: fleet.userHome, FYD_WATCHDOG_SECONDS: '0' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: Bun.file(join(fleet.home, 'fyd.err')),
  });
  const base = `http://127.0.0.1:${String(await recordedPort(fleet.home))}`;
  try {
    for (let attempt = 0; (await fetch(`${base}/healthz`).catch(() => undefined))?.ok !== true; attempt += 1) {
      if (attempt > 600)
        throw new Error(`the daemon never answered: ${await readFile(join(fleet.home, 'fyd.err'), 'utf8')}`);
      await Bun.sleep(100);
    }
    const token = (await readFile(join(fleet.home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const profile = async (seconds: number, during: () => Promise<void> = async () => undefined) => {
      const started = await fetch(`${base}/v1/diagnostics/profile`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ seconds }),
      });
      should(started.status).equal(202);
      const { id } = (await started.json()) as PerformanceProfileView;
      await during();
      await Bun.sleep(seconds * 1_000);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const view = (await (
          await fetch(`${base}/v1/diagnostics/profile/${id}`, { headers })
        ).json()) as PerformanceProfileView;
        if (view.state === 'finished') return view.report;
        await Bun.sleep(250);
      }
      throw new Error('the profile never finished');
    };
    // Quiet first: every worker attached and its first look made, so the window below counts only the draw.
    for (let attempt = 0; ; attempt += 1) {
      const warmup = await profile(5);
      if (looksIn(warmup) === 0 && warmup.workers.some(worker => worker.name === 'session-observer')) break;
      if (attempt > 12) throw new Error('the daemon never went quiet');
    }
    // One pane draws once (the terminal echoes what is typed at it); the other stays idle throughout.
    return await profile(5, async () => {
      await Bun.sleep(1_000);
      tmux(['send-keys', '-t', panes[0] ?? '', 'drawn']);
    });
  } finally {
    daemon.kill();
    await daemon.exited;
    tmux(['kill-server']);
  }
}

function looksIn(report: PerformanceReport): number {
  return report.activities.find(activity => activity.name === 'session worker look')?.count ?? 0;
}

describe('session workers in a booted daemon', () => {
  for (const [mode, max] of [
    ['a thread per session', 8],
    ['every session pooled on one thread', 1],
  ] as const)
    it(`should look at a running session only when its pane drew, with ${mode}`, async () => {
      // Act
      const report = await profiled({ max });

      // Assert
      should(report.fleet).deepEqual({ sessions: 4, running: RUNNING });
      should(report.workers.map(worker => worker.name)).containEql('session-observer');
      // Looks happen when something happened: the draw is looked at, the idle pane is not — no 2 s polling.
      should(looksIn(report)).be.aboveOrEqual(1);
      should(looksIn(report)).be.belowOrEqual(3);
      // And this thread has no tick of its own: every running session is its worker's.
      should(report.activities.find(activity => activity.name === 'turn watcher')?.count ?? 0).be.belowOrEqual(1);
    }, 180_000);

  it('should still observe on the workers when the retired switch says to turn them off', async () => {
    // Act
    const report = await profiled({ enabled: false });

    // Assert
    should(report.workers.map(worker => worker.name)).containEql('session-observer');
    should(looksIn(report)).be.aboveOrEqual(1);
  }, 180_000);
});
