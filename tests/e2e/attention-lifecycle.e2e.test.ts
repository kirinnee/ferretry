import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, setDefaultTimeout } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';

/**
 * Attention lifecycle against a REAL `fyd`, not a stub.
 *
 * `command-groups.e2e.test.ts`'s attention journey (and `packages/cli/tests/sit/
 * attention.sit.test.ts`) both drive the compiled `fy` binary against a stand-in HTTP server. Neither
 * proves the daemon's own session-registry authorization (`AttentionSessionDirectory.has`) or its real
 * `AttentionService`/state-machine. This journey does: it boots the compiled `fyd` for real, gets a
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
 * SESSION START: getting a session INTO the registry needs a fleet account with an "auto" route;
 * `fleet init` only ever declares the interactive one and there is no CLI flag for the other (checked
 * `fleet init --help`), so `bootRealSession` patches one into the generated `config.yaml` before
 * `fleet apply`.
 *
 * The started session's underlying agent process reliably ends up `failed`: the daemon refuses
 * "caller-supplied tmux socket overrides" on principle, and this fixture's `childEnvironment()`
 * carries `FY_E2E_TMUX_SOCKET`/`FY_E2E_REAL_TMUX` for its OWN PATH-level `tmux` routing — the daemon
 * reads them too and (correctly, per its own security posture) refuses. That refusal is a
 * `packages/daemon` decision this file must not paper over or work around; it does not need the agent
 * process to actually run, only for the session's id to exist in the registry — which it does, since
 * the daemon persists the failure rather than declining to create the session at all. Only the
 * returned session id is asserted on below; nothing here asserts the launch itself succeeds.
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

/** `fleet init` only ever declares the interactive route; `fy start`'s default mode needs an auto one. */
async function declareAutoRoute(configPath: string): Promise<void> {
  const original = await readFile(configPath, 'utf8');
  const marker = '        models:\n          - claude-opus-5\n\n# ── Example';
  if (!original.includes(marker)) {
    throw new Error('expected fleet starter shape changed; update the auto-route patch in this test');
  }
  const autoRoute = [
    '      auto:',
    `        id: ${crypto.randomUUID()}`,
    '        wrapper: claude-auto-primary',
    '        home: claude-auto-primary',
    '        displayName: Claude (primary, automation)',
    '        defaultModel: claude-opus-5',
    '        models:',
    '          - claude-opus-5',
    '',
  ].join('\n');
  await writeFile(
    configPath,
    original.replace(marker, `        models:\n          - claude-opus-5\n${autoRoute}\n# ── Example`),
    'utf8',
  );
}

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

/** Fleet account, real `fyd` on the leased port, and one real (if execution-`failed`) session. */
async function bootRealSession(environment: E2eEnvironment): Promise<RealSession> {
  await environment.installFakeHarness('claude');
  await environment.setFakeHarnessScenario({ version: 1, steps: [{ type: 'exit', code: 0 }] });
  await environment.runFy(['fleet', 'init', '--first-account=claude']);
  await declareAutoRoute(join(environment.paths.fyHome, 'fleet', 'config.yaml'));
  const applied = await environment.runFy(['fleet', 'apply']);
  should(applied.code).equal(0, applied.err);

  const fydBinary = await resolveFydBinary(environment.repositoryRoot);
  await environment.startDaemon({
    command: [fydBinary, '--host', '127.0.0.1', '--port', String(environment.ports.api)],
    readyUrl: environment.httpUrl('/v1/health'),
    timeoutMs: 15_000,
  });
  const token = await waitForFile(join(environment.paths.fyHome, 'api-token'), 10_000);
  const connection = { FY_URL: environment.httpUrl(), FY_TOKEN: token };

  const fleetBin = join(environment.paths.fyHome, 'fleet', 'bin');
  const started = await environment.runFy(['start', '--agent', 'claude-auto-primary', 'say hi and exit', '--json'], {
    ...connection,
    PATH: `${fleetBin}:${process.env.PATH ?? ''}`,
  });
  should(started.code).equal(0, started.err);
  const sessionId = (JSON.parse(started.out) as { config?: { id?: string } }).config?.id;
  should(sessionId).not.be.undefined();

  return { connection, scoped: { ...connection, FY_SESSION_ID: String(sessionId) }, sessionId: String(sessionId) };
}

describe('attention lifecycle against a real fyd (E2E)', () => {
  it('raises, lists, answers, and audits an attention item through the live session registry', async () => {
    await withE2eEnvironment(async environment => {
      // Arrange
      const { scoped } = await bootRealSession(environment);

      // Act
      const added = await environment.runFy(['attention', 'add', 'approve the deploy', '--kind', 'permission'], scoped);
      const listedAfterAdd = await environment.runFy(['attention', 'ls'], scoped);
      const answered = await environment.runFy(['attention', 'done', '!A1', '--approve'], scoped);
      const listedAfterAnswer = await environment.runFy(['attention', 'ls'], scoped);
      const history = await environment.runFy(['attention', 'history'], scoped);

      // Assert — a real session registered with the real daemon, and the real AttentionService's
      // session-registry check (`AttentionSessionDirectory.has`) let every one of these through.
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
