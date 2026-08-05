import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import {
  FLEET_HEALTH_SENTINEL,
  ProcessFleetHealthProbe,
  runFleetHealthProcess,
  type FleetHealthProcess,
  type FleetHealthProcessResult,
} from '../../src/adapters/process-health-probe.ts';
import type { FleetManifestAccount } from '../../src/lib/manifest.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const account = (overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'claude',
  mode: 'auto',
  wrapper: '/fleet/bin/fy-claude-work',
  home: '/fleet/homes/claude-work',
  displayName: 'Claude work',
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

async function cachePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-health-probe-'));
  temporaryDirectories.push(root);
  return join(root, 'state', 'successes.json');
}

class RecordingProcess implements FleetHealthProcess {
  readonly calls: Array<{ command: readonly string[]; timeoutMs: number }> = [];

  constructor(private readonly replies: Array<FleetHealthProcessResult | Error | string>) {}

  run(command: readonly string[], timeoutMs: number): Promise<FleetHealthProcessResult> {
    this.calls.push({ command, timeoutMs });
    const reply = this.replies.shift();
    if (reply === undefined) return Promise.reject(new Error('unexpected probe'));
    if (reply instanceof Error || typeof reply === 'string') return Promise.reject(reply);
    return Promise.resolve(reply);
  }
}

describe('ProcessFleetHealthProbe', () => {
  it('should prove an exact sentinel, record that success privately, and reuse it only inside its TTL', async () => {
    // Arrange
    const path = await cachePath();
    const process = new RecordingProcess([{ stdout: `${FLEET_HEALTH_SENTINEL}\n`, stderr: '', exitCode: 0 }]);
    const probe = new ProcessFleetHealthProbe({ process, cachePath: path, now: () => 1_000, timeoutMs: 17 });

    // Act
    const fresh = await probe.probe(account());
    const cached = await probe.probe(account());

    // Assert — exit zero is insufficient; this is the one exact successful reply.
    should(fresh).deepEqual({ state: 'healthy', cached: false, checkedAt: 1_000, ms: fresh.ms });
    should(cached).deepEqual({ state: 'healthy', cached: true, checkedAt: 1_000, ms: 0 });
    should(process.calls).have.length(1);
    should(process.calls[0]?.timeoutMs).equal(17);
    should(process.calls[0]?.command).deepEqual([
      '/fleet/bin/fy-claude-work',
      '--print',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--no-chrome',
      '--tools',
      '',
      `Reply with exactly: ${FLEET_HEALTH_SENTINEL} and nothing else.`,
    ]);
    should(JSON.parse(await readFile(path, 'utf8'))).deepEqual({
      version: 1,
      successes: { '/fleet/bin/fy-claude-work': 1_000 },
    });
  });

  it('should cache only valid success documents and use the Codex command shape when a probe is needed', async () => {
    // Arrange
    const path = await cachePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"version":0,"successes":"not-a-map"}\n', 'utf8');
    const process = new RecordingProcess([{ stdout: FLEET_HEALTH_SENTINEL, stderr: '', exitCode: 0 }]);
    const probe = new ProcessFleetHealthProbe({ process, cachePath: path, now: () => 2_000 });

    // Act
    await probe.probe(account({ kind: 'codex', wrapper: '/fleet/bin/fy-codex-work' }));

    // Assert
    should(process.calls[0]?.command).deepEqual([
      '/fleet/bin/fy-codex-work',
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '-c',
      'model_reasoning_effort="low"',
      `Reply with exactly: ${FLEET_HEALTH_SENTINEL} and nothing else.`,
    ]);
  });

  it('should make every non-sentinel and failing exit explicit instead of treating it as healthy', async () => {
    // Arrange
    const process = new RecordingProcess([
      { stdout: 'almost', stderr: '', exitCode: 0 },
      { stdout: '\u001b[31m429 quota exhausted\u001b[0m', stderr: '', exitCode: 1 },
      { stdout: '', stderr: '401 unauthorized', exitCode: 1 },
      { stdout: '', stderr: 'worker exploded', exitCode: 2 },
    ]);
    const probe = new ProcessFleetHealthProbe({ process, cachePath: await cachePath(), now: () => 3_000 });

    // Act
    const replies = [];
    for (const id of ['unexpected', 'rate', 'auth', 'broken'])
      replies.push(await probe.probe(account({ wrapper: id })));

    // Assert
    should(replies.map(reply => reply.failureKind)).deepEqual([
      'unexpected_reply',
      'rate_limited',
      'authentication',
      'process_error',
    ]);
    should(replies[0]?.error).match(/expected exact sentinel/u);
    should(replies[1]?.error).equal('probe exited 1: 429 quota exhausted');
    should(replies[2]?.error).equal('probe exited 1: 401 unauthorized');
    should(replies[3]?.error).equal('probe exited 2: worker exploded');
  });

  it('should distinguish a timeout from a launch failure and retain observed success when its cache cannot be written', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'ferretry-health-probe-blocker-'));
    temporaryDirectories.push(root);
    const blocker = join(root, 'not-a-directory');
    await writeFile(blocker, 'blocked', 'utf8');
    const process = new RecordingProcess([
      new Error('timed out after 30ms'),
      'spawn refused',
      { stdout: FLEET_HEALTH_SENTINEL, stderr: '', exitCode: 0 },
    ]);
    const probe = new ProcessFleetHealthProbe({
      process,
      cachePath: join(blocker, 'successes.json'),
      now: () => 4_000,
    });

    // Act
    const timeout = await probe.probe(account({ wrapper: 'timeout' }));
    const launch = await probe.probe(account({ wrapper: 'launch' }));
    const success = await probe.probe(account({ wrapper: 'success' }));

    // Assert — cache trouble never changes a completed sentinel turn into a false outage.
    should(timeout).containEql({ state: 'down', failureKind: 'timeout' });
    should(timeout.error).equal('timed out: timed out after 30ms');
    should(launch).containEql({ state: 'unknown', failureKind: 'launch' });
    should(launch.error).equal('could not launch probe: spawn refused');
    should(success).containEql({ state: 'healthy', cached: false, checkedAt: 4_000 });
  });
});

describe('runFleetHealthProcess', () => {
  it('should carry stdout, stderr, and a non-zero exit from a real child process', async () => {
    // Act
    const actual = await runFleetHealthProcess.run(
      [process.execPath, '-e', 'console.log("sentinel"); console.error("diagnostic"); process.exit(7)'],
      1_000,
    );

    // Assert
    should(actual).deepEqual({ stdout: 'sentinel\n', stderr: 'diagnostic\n', exitCode: 7 });
  });

  it('should kill a child that exceeds its declared timeout', async () => {
    await should(
      runFleetHealthProcess.run([process.execPath, '-e', 'setInterval(() => {}, 1_000)'], 10),
    ).be.rejectedWith(/timed out after 10ms/u);
  });
});
