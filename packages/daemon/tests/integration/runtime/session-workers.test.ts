/**
 * ONE THREAD PER RUNNING SESSION, IN A REAL DAEMON — and the switch that turns it off.
 *
 * Boots a real `fyd` from source over a small fleet with REAL tmux panes for its running sessions, once
 * with `sessionWorkers.enabled` (the default) and once without, and asks the daemon's own profile what
 * ran. With workers on, each running session is looked at by its worker — the profile's workers table
 * names the session observer and its activity table counts the workers' looks, reported across the
 * thread boundary. With them off, nothing of the kind exists and the inline turn watcher does it all.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PerformanceProfileView, PerformanceReport } from '@ferretry/protocol';
import should from 'should';
import { freeLoopbackPort } from '../support/booted-daemon.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { scaledFleet, sessionIdOf } from '../support/scaled-fleet.ts';

const FYD_ENTRY = resolve(import.meta.dir, '../../../bin/fyd.ts');
const RUNNING = 2;

afterAll(async () => {
  await cleanupTempDirectories();
});

async function profiled(enabled: boolean): Promise<PerformanceReport> {
  const fleet = await scaledFleet(await tempDirectory(`fyd-session-workers-${String(enabled)}-`), {
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
  for (let index = 0; index < RUNNING; index += 1) {
    const config = JSON.parse(
      await readFile(join(fleet.home, 'state', 'sessions', sessionIdOf(index), 'config.json'), 'utf8'),
    ) as { tmuxSession: string };
    should(tmux(['new-session', '-d', '-s', config.tmuxSession, '-x', '120', '-y', '30', 'sleep 3600']).exitCode).equal(
      0,
    );
  }
  const port = await freeLoopbackPort();
  await mkdir(join(fleet.home, 'config'), { recursive: true });
  await writeFile(
    join(fleet.home, 'config', 'daemon.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port,
      relay: { url: 'ws://127.0.0.1:9', enabled: false },
      sessionWorkers: { enabled },
    }),
  );
  const daemon = Bun.spawn([process.execPath, FYD_ENTRY], {
    env: { ...process.env, FY_HOME: fleet.home, HOME: fleet.userHome, FYD_WATCHDOG_SECONDS: '0' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: Bun.file(join(fleet.home, 'fyd.err')),
  });
  const base = `http://127.0.0.1:${String(port)}`;
  try {
    for (let attempt = 0; (await fetch(`${base}/healthz`).catch(() => undefined))?.ok !== true; attempt += 1) {
      if (attempt > 600)
        throw new Error(`the daemon never answered: ${await readFile(join(fleet.home, 'fyd.err'), 'utf8')}`);
      await Bun.sleep(100);
    }
    // Long enough for the workers to start and answer their probes.
    await Bun.sleep(3_000);
    const token = (await readFile(join(fleet.home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const started = await fetch(`${base}/v1/diagnostics/profile`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ seconds: 5 }),
    });
    should(started.status).equal(202);
    const { id } = (await started.json()) as PerformanceProfileView;
    await Bun.sleep(5_000);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const view = (await (
        await fetch(`${base}/v1/diagnostics/profile/${id}`, { headers })
      ).json()) as PerformanceProfileView;
      if (view.state === 'finished') return view.report;
      await Bun.sleep(250);
    }
    throw new Error('the profile never finished');
  } finally {
    daemon.kill();
    await daemon.exited;
    tmux(['kill-server']);
  }
}

describe('session workers in a booted daemon', () => {
  it('should look at each running session on its own worker, and count those looks in the profile', async () => {
    // Act
    const report = await profiled(true);

    // Assert
    should(report.fleet).deepEqual({ sessions: 4, running: RUNNING });
    should(report.workers.map(worker => worker.name)).containEql('session-observer');
    const looks = report.activities.find(activity => activity.name === 'session worker look');
    should(looks?.count ?? 0).be.above(0);
    should(report.activities.map(activity => activity.name)).containEql('turn watcher');
  }, 120_000);

  it('should observe every session on the main thread when the workers are switched off', async () => {
    // Act
    const report = await profiled(false);

    // Assert
    should(report.workers.map(worker => worker.name)).not.containEql('session-observer');
    should(report.activities.map(activity => activity.name)).not.containEql('session worker look');
    should(report.activities.map(activity => activity.name)).containEql('turn watcher');
  }, 120_000);
});
