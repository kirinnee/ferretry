/**
 * The Codex renewal path, against a real child: a stand-in `codex` on a private PATH that reads the two JSON-RPC lines
 * the daemon writes and answers the way the real app-server was measured to. Only closed-set evidence comes out.
 */
import { afterEach, describe, it } from 'bun:test';
import { bunSpawn, systemClock } from '@ferretry/kernel/host';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { codexTokenRefresh } from '../../../daemon/adapters/credentials/token-refresh.ts';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

/** A private PATH holding a `codex` script with this body, plus the system tools it needs. */
async function codexOnPath(body: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'fy-codex-refresh-'));
  folders.push(folder);
  await writeFile(join(folder, 'codex'), `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(join(folder, 'codex'), 0o700);
  return `${folder}:/usr/bin:/bin`;
}

const target = { kind: 'codex', home: '/nonexistent/codex-home' } as never;
const clock = systemClock();
const never = async (): Promise<boolean> => false;

describe('the Codex renewal path', () => {
  it('should leave a Claude login alone, because Claude renews its own on its next use', async () => {
    const refresh = codexTokenRefresh(bunSpawn({ PATH: '/usr/bin:/bin' }), clock);

    const attempt = await refresh.refresh({ kind: 'claude' } as never, never);

    should(attempt.outcome).equal('unavailable');
  });

  it('should hand back the closed-set words the app-server printed, and nothing else it said', async () => {
    const path = await codexOnPath(
      'cat >/dev/null & echo "secret-looking-payload sk-TESTONLY" ; echo "refresh_token_expired: please sign in" >&2; echo "token refresh failed 401" >&2; sleep 1',
    );
    const refresh = codexTokenRefresh(bunSpawn({ PATH: path }), clock);

    const attempt = await refresh.refresh(target, never);

    should(attempt).deepEqual({
      outcome: 'ran',
      evidence: { codes: ['refresh_token_expired'], unauthorized: true },
    });
    should(JSON.stringify(attempt)).not.containEql('sk-TESTONLY');
  });

  it('should stop at once when the credential says the work is done, killing the child', async () => {
    const path = await codexOnPath('cat >/dev/null; sleep 30');
    const refresh = codexTokenRefresh(bunSpawn({ PATH: path }), clock);

    const attempt = await refresh.refresh(target, async () => true);

    should(attempt).deepEqual({ outcome: 'ran', evidence: { codes: [], unauthorized: false } });
  });

  it('should keep polling a quiet child until it is done, and end it when its deadline passes', async () => {
    // Arrange — the same real clock with the 30 s deadline brought down to what a test can wait for.
    const quick = {
      ...clock,
      after: (_delay: unknown, fn: () => void) => {
        const handle = setTimeout(fn, 150);
        return () => clearTimeout(handle);
      },
    };
    const path = await codexOnPath('cat >/dev/null; sleep 30');
    const refresh = codexTokenRefresh(bunSpawn({ PATH: path }), quick as never);

    // Act
    const attempt = await refresh.refresh(target, never);

    // Assert
    should(attempt).deepEqual({ outcome: 'ran', evidence: { codes: [], unauthorized: false } });
  });

  it('should say the renewal could not be run when there is no codex to run', async () => {
    const refresh = codexTokenRefresh(bunSpawn({ PATH: '/nonexistent-bin' }), clock);

    const attempt = await refresh.refresh(target, never);

    should(attempt).deepEqual({ outcome: 'error', reason: 'the renewal could not be run' });
  });

  it('should keep what it found when a stream dies before the child does', async () => {
    const path = await codexOnPath('cat >/dev/null & echo "invalid_grant" >&2; sleep 1');
    const real = bunSpawn({ PATH: path });
    const dying = {
      ...real,
      start: (...given: Parameters<typeof real.start>) => {
        const handle = real.start(...given);
        return {
          ...handle,
          stdout: new ReadableStream<Uint8Array>({
            start: controller => controller.error(new Error('the pipe broke')),
          }),
        };
      },
    };

    const attempt = await codexTokenRefresh(dying as never, clock).refresh(target, never);

    should(attempt).deepEqual({ outcome: 'ran', evidence: { codes: ['invalid_grant'], unauthorized: false } });
  });

  it('should force file storage, so a Check now can never move the credential into a keyring', async () => {
    // Arrange — a stand-in that records the argument list it was started with.
    const log = join(await mkdtemp(join(tmpdir(), 'fy-codex-argv-')), 'argv');
    folders.push(join(log, '..'));
    const path = await codexOnPath(`printf '%s\\n' "$@" > ${log}; cat >/dev/null; sleep 1`);
    const refresh = codexTokenRefresh(bunSpawn({ PATH: path }), clock);

    // Act
    await refresh.refresh(
      target,
      async () =>
        await readFile(log).then(
          () => true,
          () => false,
        ),
    );

    // Assert — the same key the sign-in passes (credentials-service), and the subcommand it runs.
    const argv = (await readFile(log, 'utf8')).trim().split('\n');
    should(argv).containEql('app-server');
    const at = argv.indexOf('-c');
    should(at).aboveOrEqual(0);
    should(argv[at + 1]).equal('cli_auth_credentials_store="file"');
  });
});
