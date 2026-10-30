import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, setDefaultTimeout } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';

/**
 * Attention lifecycle against a REAL `fyd`, not a stub.
 *
 * `command-groups.e2e.test.ts`'s attention journey (and `packages/cli/tests/sit/
 * attention.sit.test.ts`) both drive the compiled `fy` binary against a stand-in HTTP server. Neither
 * proves the daemon's own session-registry authorization (`AgendaSessionDirectory.has`) or its real
 * `AgendaService`/state-machine. This journey does: it boots the compiled `fyd` for real, gets a
 * genuine session id into its live registry, and drives `fy attention` against that same daemon.
 *
 * PORT ISOLATION: `fyd` accepts `--host`/`--port` (`packages/daemon/tests/unit/runtime/arguments.
 * test.ts`), so this boots it directly on `environment.ports.api` — this run's leased ephemeral port,
 * never a hardcoded one — and `startDaemon` releases that lease immediately before spawning, so
 * nothing else can steal it in between. `readyUrl: environment.httpUrl('/v1/health')` waits for that
 * exact bind. If `fyd` ever refuses an explicit `--port` on a fresh home (it has not so far), the
 * bootstrap health wait below times out and throws with `fyd`'s own stderr attached, rather than
 * silently falling back to some other, uncontrolled port.
 *
 * SESSION START: getting a session INTO the registry needs an agent runtime. `fleet init` and
 * `fleet apply` were retired with the old account system (#458); a machine now gets its runtimes from
 * `fy daemon import claude`, which reads an invented `~/.claude` in the temp HOME and creates
 * `claude-default` (an agent runtime). Its login is never signed in, and nothing here needs the agent
 * process to run: only the session id has to exist in the live registry, and only that id is asserted
 * on below.
 *
 * The daemon gets its own private tmux socket (`useDaemonPrivateTmux`) because it now passes `-S`
 * itself, which the fixture's PATH router refuses, and its relay discovery points at a closed
 * loopback port so the boot never dials a real directory.
 */

setDefaultTimeout(60_000);

async function resolveFydBinary(repositoryRoot: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, 'packages', 'daemon', 'package.json'), 'utf8'),
  ) as { readonly bin: Readonly<Record<string, string>> };
  const binaryName = Object.keys(packageJson.bin)[0];
  if (binaryName === undefined) throw new Error('packages/daemon/package.json declares no bin entry');
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(repositoryRoot, 'dist', 'bin', `${binaryName}-${platform}-${architecture}`);
}

/** The one runtime `daemon import claude` creates; it is an agent runtime (`agent: true` in `fy runtimes --json`). */
const AGENT_RUNTIME = 'claude-default';

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(path, 'utf8').catch(() => undefined);
    if (content !== undefined && content.trim() !== '') return content.trim();
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

interface RealSession {
  readonly connection: Readonly<Record<string, string>>;
  readonly scoped: Readonly<Record<string, string>>;
  readonly sessionId: string;
}

/** A Claude runtime imported into a real `fyd` on the leased port, and one real session on it. */
async function bootRealSession(environment: E2eEnvironment): Promise<RealSession> {
  // The person's own Claude Code, as `daemon import` reads it — invented, in the temp HOME.
  const fakeClaude = await environment.installFakeHarness('claude');
  await environment.setFakeHarnessScenario({ version: 1, steps: [{ type: 'exit', code: 0 }] });
  await mkdir(join(environment.paths.home, '.claude'), { recursive: true });
  await writeFile(join(environment.paths.home, '.claude', 'CLAUDE.md'), '# e2e\n', 'utf8');

  const fydBinary = await resolveFydBinary(environment.repositoryRoot);
  await environment.startDaemon({
    command: [fydBinary, '--host', '127.0.0.1', '--port', String(environment.ports.api)],
    readyUrl: environment.httpUrl('/v1/health'),
    timeoutMs: 15_000,
    // The daemon drives tmux on its own private socket; the fixture's PATH router refuses that.
    useDaemonPrivateTmux: true,
    // Relay discovery pointed at a closed loopback port: nothing here needs a carrier. Claude is located
    // through FY_CLAUDE_BIN for the import, and the session's wrapper execs `claude` BY NAME, which finds
    // the same fake because `harnessBin` is first on the daemon's PATH. Before it was, this journey
    // launched the developer's REAL Claude Code in a tmux server nothing ever killed.
    env: { FY_RELAY_DIRECTORY_ORIGIN: 'http://127.0.0.1:9', FY_CLAUDE_BIN: fakeClaude },
  });
  const token = await waitForFile(join(environment.paths.fyHome, 'api-token'), 10_000);
  const connection = { FY_URL: environment.httpUrl(), FY_TOKEN: token };

  const imported = await environment.runFy(['daemon', 'import', 'claude'], connection);
  should(imported.code).equal(0, imported.err);
  const started = await environment.runFy(['start', '--agent', AGENT_RUNTIME, 'say hi and exit', '--json'], connection);
  should(started.code).equal(0, started.err);
  const sessionId = (JSON.parse(started.out) as { config?: { id?: string } }).config?.id;
  should(sessionId).not.be.undefined();

  return { connection, scoped: { ...connection, FY_SESSION_ID: String(sessionId) }, sessionId: String(sessionId) };
}

describe('attention lifecycle against a real fyd (E2E)', () => {
  it('raises, lists, answers, and audits an agenda item through the live session registry', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const { scoped } = await bootRealSession(environment);

      // Act
      const added = await environment.runFy(['attention', 'add', 'approve the deploy', '--kind', 'permission'], scoped);
      const listedAfterAdd = await environment.runFy(['attention', 'ls'], scoped);
      const answered = await environment.runFy(['attention', 'done', '!A1', '--approve'], scoped);
      const listedAfterAnswer = await environment.runFy(['attention', 'ls'], scoped);
      const history = await environment.runFy(['attention', 'history'], scoped);

      // Assert — a real session registered with the real daemon, and the real AgendaService's
      // session-registry check (`AgendaSessionDirectory.has`) let every one of these through.
      should(added.code).equal(0, added.err);
      should(added.out).containEql('!A1');
      should(listedAfterAdd.code).equal(0, listedAfterAdd.err);
      should(listedAfterAdd.out).containEql('!A1');
      should(answered.code).equal(0, answered.err);
      should(listedAfterAnswer.code).equal(0, listedAfterAnswer.err);
      should(listedAfterAnswer.out).not.containEql('!A1'); // resolved leaves the active view immediately
      should(history.code).equal(0, history.err);
      should(history.out).containEql('!A1');
      should(history.out).containEql('approved'); // the exact typed response, not just "resolved"
    });
  });

  it('dismisses a multiple-choice item and keeps it in the audit with its note', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const { scoped } = await bootRealSession(environment);

      // Act
      const added = await environment.runFy(
        ['attention', 'add', 'pick a cluster', '--kind', 'choice', '--option', 'staging', '--option', 'prod'],
        scoped,
      );
      const dismissed = await environment.runFy(
        ['attention', 'dismiss', '!A1', '--note', 'superseded by the next release'],
        scoped,
      );
      const listedAfterDismiss = await environment.runFy(['attention', 'ls'], scoped);
      const history = await environment.runFy(['attention', 'history'], scoped);

      // Assert
      should(added.code).equal(0, added.err);
      should(dismissed.code).equal(0, dismissed.err);
      should(listedAfterDismiss.out).not.containEql('!A1');
      should(history.out).containEql('!A1');
      should(history.out).containEql('dismissed by human');
      should(history.out).containEql('superseded by the next release');
    });
  });
});
