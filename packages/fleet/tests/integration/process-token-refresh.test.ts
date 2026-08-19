/**
 * The renewal port with a recorded spawn, and its process boundary against a real child.
 *
 * No test launches a harness. The two paths are genuinely different — one command that exits, and one
 * server that does not — so each is proved separately, and neither is allowed to conclude anything
 * about the credential: this port's only successful outcome is `ran`.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import type { FleetTokenRefreshProcess, FleetTokenRefreshSpawn } from '../../src/adapters/process-token-refresh.ts';
import {
  FLEET_TOKEN_REFRESH_POLL_MS,
  FLEET_TOKEN_REFRESH_TIMEOUT_MS,
  ProcessFleetTokenRefreshPort,
  spawnFleetTokenRefreshProcess,
} from '../../src/adapters/process-token-refresh.ts';
import type { FleetBinaryLookup } from '../../src/adapters/process-login.ts';
import type { FleetTokenRefreshSettled, FleetTokenRefreshTarget } from '../../src/lib/token-refresh.ts';

const HOME = '/fleet/homes/claude-kirin';

const target = (overrides: Partial<FleetTokenRefreshTarget> = {}): FleetTokenRefreshTarget => ({
  accountId: '00000000-0000-4000-8000-000000000001',
  kind: 'claude',
  home: HOME,
  ...overrides,
});

const installed: FleetBinaryLookup = binary => `/usr/bin/${binary}`;
const neverInstalled: FleetBinaryLookup = () => undefined;

const never: FleetTokenRefreshSettled = () => Promise.resolve(false);
const already: FleetTokenRefreshSettled = () => Promise.resolve(true);

interface Recorded {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** A child that records what it was told and exits when it is told to, or when it is killed. */
class FakeProcess implements FleetTokenRefreshProcess {
  readonly writes: string[] = [];
  closed = 0;
  killed = 0;
  readonly exited: Promise<number>;
  #finish: (code: number) => void = () => undefined;

  constructor(exitCode?: number) {
    this.exited = new Promise<number>(resolve => {
      this.#finish = resolve;
    });
    if (exitCode !== undefined) this.#finish(exitCode);
  }

  write(text: string): Promise<void> {
    this.writes.push(text);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  kill(): void {
    this.killed += 1;
    this.#finish(137);
  }
}

const recorder =
  (calls: Recorded[], child: FleetTokenRefreshProcess): FleetTokenRefreshSpawn =>
  (command, environment) => {
    calls.push({ command, environment });
    return child;
  };

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-token-refresh-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(each => rm(each, { recursive: true, force: true })));
});

describe('ProcessFleetTokenRefreshPort', () => {
  it('should declare the defaults it renews under, rather than leaving them to a call site', () => {
    // Assert — the ceiling covers an OAuth round trip; the poll is short because the read is local.
    should(FLEET_TOKEN_REFRESH_TIMEOUT_MS).equal(30_000);
    should(FLEET_TOKEN_REFRESH_POLL_MS).equal(250);
  });

  it('should refuse a host without the harness installed, having spawned nothing at all', async () => {
    // Arrange
    const calls: Recorded[] = [];
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder(calls, new FakeProcess(0)),
      environment: {},
      which: neverInstalled,
    });

    // Act
    const actual = await subject.refresh(target(), never);

    // Assert
    should(calls).deepEqual([]);
    should(actual).match({ outcome: 'unavailable', reason: /"claude" CLI is not on this host/u });
  });

  it('should drive Claude down its connectors path, which invokes no model', async () => {
    // Arrange
    const calls: Recorded[] = [];
    const child = new FakeProcess(0);
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder(calls, child),
      environment: {},
      which: installed,
    });

    // Act
    const actual = await subject.refresh(target(), never);

    // Assert — stdin is closed because this path is asked nothing.
    should(calls[0]?.command).deepEqual(['/usr/bin/claude', 'mcp', 'list']);
    should(child.closed).equal(1);
    should(actual).deepEqual({ outcome: 'ran' });
  });

  it("should point the harness at this account's home and strip the caller's provider variables", async () => {
    // Arrange — every fleet command runs inside somebody's agent session, and that session exports
    // credentials of its own; passing them through is how a renewal authenticates as another account.
    const calls: Recorded[] = [];
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder(calls, new FakeProcess(0)),
      environment: {
        ANTHROPIC_API_KEY: 'the-calling-session-key',
        CLAUDE_CONFIG_DIR: '/somebody/elses/home',
        CLAUDECODE: '1',
        PATH: '/usr/bin',
        FY_UNRELATED: 'kept',
      },
      which: installed,
    });

    // Act
    await subject.refresh(target(), never);

    // Assert
    should(calls[0]?.environment).deepEqual({
      PATH: '/usr/bin',
      FY_UNRELATED: 'kept',
      CLAUDE_CONFIG_DIR: HOME,
    });
  });

  it('should not read the exit code as a verdict, because a down MCP server is not a dead credential', async () => {
    // Arrange
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder([], new FakeProcess(1)),
      environment: {},
      which: installed,
    });

    // Act
    const actual = await subject.refresh(target(), never);

    // Assert
    should(actual).deepEqual({ outcome: 'ran' });
  });

  it('should stop a Claude path that will not finish, rather than wedging the fleet command', async () => {
    // Arrange — a child that only ever exits when it is killed.
    const child = new FakeProcess();
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder([], child),
      environment: {},
      which: installed,
      timeoutMs: 0,
    });

    // Act
    const actual = await subject.refresh(target(), never);

    // Assert
    should(child.killed).equal(1);
    should(actual).deepEqual({ outcome: 'ran' });
  });

  it('should ask the Codex app server to rotate the token, and ask it not to hand one over', async () => {
    // Arrange
    const calls: Recorded[] = [];
    const child = new FakeProcess();
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder(calls, child),
      environment: {},
      which: installed,
      sleep: () => Promise.resolve(),
    });

    // Act
    const actual = await subject.refresh(target({ kind: 'codex', home: '/fleet/homes/codex-kirin' }), already);

    // Assert
    should(calls[0]?.command).deepEqual(['/usr/bin/codex', 'app-server']);
    should(calls[0]?.environment).deepEqual({ CODEX_HOME: '/fleet/homes/codex-kirin' });
    const requests = (child.writes[0] ?? '')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    should(requests.map(request => request.method)).deepEqual(['initialize', 'getAuthStatus']);
    should(requests[1]?.params).deepEqual({ includeToken: false, refreshToken: true });
    should(actual).deepEqual({ outcome: 'ran' });
  });

  it('should stop the app server as soon as the credential has settled, and not sleep for a guess', async () => {
    // Arrange
    const slept: number[] = [];
    const child = new FakeProcess();
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder([], child),
      environment: {},
      which: installed,
      sleep: ms => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    // Act
    await subject.refresh(target({ kind: 'codex' }), already);

    // Assert — the server never exits on its own, so it is stopped rather than waited on.
    should(slept).deepEqual([]);
    should(child.closed).equal(1);
    should(child.killed).equal(1);
  });

  it('should keep waiting while the credential has not settled, within the ceiling it was given', async () => {
    // Arrange
    const slept: number[] = [];
    const child = new FakeProcess();
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder([], child),
      environment: {},
      which: installed,
      timeoutMs: 100,
      pollMs: 25,
      sleep: ms => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    // Act
    const actual = await subject.refresh(target({ kind: 'codex' }), never);

    // Assert
    should(slept).deepEqual([25, 25, 25, 25]);
    should(child.killed).equal(1);
    should(actual).deepEqual({ outcome: 'ran' });
  });

  it('should wait on a real timer, and stop the server when the ceiling is reached', async () => {
    // Arrange — nothing injected, so the shipped delay and the shipped backstop both run.
    const child = new FakeProcess();
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: recorder([], child),
      environment: {},
      which: installed,
      timeoutMs: 1,
      pollMs: 1,
    });

    // Act
    const actual = await subject.refresh(target({ kind: 'codex' }), never);

    // Assert
    should(child.killed).be.aboveOrEqual(1);
    should(actual).deepEqual({ outcome: 'ran' });
  });

  it('should report a renewal it could not start as an error, never as something that ran', async () => {
    // Arrange
    const subject = new ProcessFleetTokenRefreshPort({
      spawn: () => {
        throw new Error('spawn claude EACCES');
      },
      environment: {},
      which: installed,
    });

    // Act
    const actual = await subject.refresh(target(), never);

    // Assert
    should(actual).deepEqual({ outcome: 'error', reason: 'spawn claude EACCES' });
  });
});

describe('spawnFleetTokenRefreshProcess', () => {
  it('should carry what is written on stdin through to the child, then close it', async () => {
    // Arrange
    const shell = Bun.which('sh') ?? '/bin/sh';
    const directory = await temporaryDirectory();
    const output = path.join(directory, 'received');

    // Act
    const child = spawnFleetTokenRefreshProcess([shell, '-c', `cat > "${output}"`], { PATH: '/usr/bin:/bin' });
    await child.write('{"jsonrpc":"2.0"}\n');
    await child.close();
    const code = await child.exited;

    // Assert
    should(code).equal(0);
    should(await readFile(output, 'utf8')).equal('{"jsonrpc":"2.0"}\n');
  });

  it('should never fail a renewal over closing its own input twice', async () => {
    // Arrange
    const shell = Bun.which('sh') ?? '/bin/sh';

    // Act
    const child = spawnFleetTokenRefreshProcess([shell, '-c', 'cat >/dev/null'], { PATH: '/usr/bin:/bin' });
    await child.close();
    await child.close();

    // Assert
    should(await child.exited).equal(0);
  });

  it('should stop a server that would otherwise never exit', async () => {
    // Arrange
    const shell = Bun.which('sh') ?? '/bin/sh';

    // Act
    const child = spawnFleetTokenRefreshProcess([shell, '-c', 'sleep 30'], { PATH: '/usr/bin:/bin' });
    child.kill();
    const code = await child.exited;

    // Assert — a signalled child is not exit zero, and this port draws no conclusion from either.
    should(code).not.equal(0);
  });
});
