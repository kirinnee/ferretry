import { afterEach, beforeEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { daemonConnection } from '../../../bin/fy.ts';
import {
  DaemonTokenFileError,
  type DaemonTokenFileSystem,
  readDaemonToken,
} from '../../../src/adapters/daemon/api-token.ts';

async function expectTokenFailure(path: string, expected: RegExp, fileSystem?: DaemonTokenFileSystem): Promise<void> {
  const failure = await readDaemonToken(path, fileSystem).then(
    () => undefined,
    error => error,
  );
  should(failure).be.instanceOf(DaemonTokenFileError);
  should((failure as Error).message).match(expected);
}

describe('daemon API token file', () => {
  let root = '';
  let tokenPath = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-api-token-'));
    tokenPath = join(root, 'api-token');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should use the owner-only token fyd issued when FY_TOKEN is absent', async () => {
    // Arrange
    await writeFile(tokenPath, ' daemon-secret\n', { mode: 0o600 });

    // Act
    const actual = await daemonConnection({ FY_HOME: root }, root);

    // Assert
    should(actual.token).equal('daemon-secret');
  });

  it('should keep FY_TOKEN as the explicit override', async () => {
    // Act — no token file is created, so success proves no local credential was consulted.
    const actual = await daemonConnection({ FY_HOME: root, FY_TOKEN: ' remote-secret ' }, root);

    // Assert
    should(actual.token).equal('remote-secret');
  });

  it('should still use the local token after an operator advertises a routed address', async () => {
    /*
     * THE RUNTIME REGRESSION, END TO END. This is the exact state the pairing screen's remedy leaves
     * a machine in: bound on every interface so a phone can reach it, advertising the one address
     * that phone can dial, on a port a first boot chose for itself. Reading that advertisement to
     * decide where to dial classified the daemon on this very desk as remote, and `fy pair` — the
     * command that printed the advice — refused to run for want of an FY_TOKEN nobody has.
     *
     * The assertions are the two halves that must hold together: loopback AT THE RECORDED PORT, and
     * the owner-only file rather than a demand for a credential.
     */
    // Arrange
    await writeFile(tokenPath, 'daemon-secret\n', { mode: 0o600 });
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(
      join(root, 'config', 'daemon.json'),
      JSON.stringify({ host: '0.0.0.0', port: 7_555, publicUrl: 'http://192.168.1.10:7555' }),
    );

    // Act
    const actual = await daemonConnection({ FY_HOME: root }, root);

    // Assert
    should(actual.baseUrl).equal('http://127.0.0.1:7555');
    should(actual.token).equal('daemon-secret');
  });

  it('should refuse to send a local token to a remote daemon', async () => {
    // Arrange
    await writeFile(tokenPath, 'daemon-secret\n', { mode: 0o600 });

    // Act / Assert
    const failure = await daemonConnection({ FY_HOME: root, FY_URL: 'https://daemon.example.test' }, root).then(
      () => undefined,
      error => error,
    );
    should((failure as Error).message).match(/never sent remotely/u);
  });

  it('should distinguish a missing token file', async () => {
    await expectTokenFailure(tokenPath, /missing at/u);
  });

  it('should distinguish a token file it cannot inspect', async () => {
    const fileSystem: DaemonTokenFileSystem = {
      stat: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      readFile: async () => 'unused',
    };

    await expectTokenFailure(tokenPath, /cannot be inspected/u, fileSystem);
  });

  it('should reject a token path that is not a regular file', async () => {
    const fileSystem: DaemonTokenFileSystem = {
      stat: async () => ({ isFile: () => false, mode: 0o600 }),
      readFile: async () => 'unused',
    };

    await expectTokenFailure(tokenPath, /not a regular file/u, fileSystem);
  });

  it('should distinguish an unreadable token file with broad permissions', async () => {
    // Arrange
    await writeFile(tokenPath, 'secret\n', { mode: 0o600 });
    await chmod(tokenPath, 0o644);

    // Act / Assert
    await expectTokenFailure(tokenPath, /owner-only/u);
  });

  it('should distinguish an empty token file', async () => {
    // Arrange
    await writeFile(tokenPath, ' \n', { mode: 0o600 });

    // Act / Assert
    await expectTokenFailure(tokenPath, /is empty/u);
  });

  it('should distinguish a token file it cannot read', async () => {
    const fileSystem: DaemonTokenFileSystem = {
      stat: async () => ({ isFile: () => true, mode: 0o600 }),
      readFile: async () => {
        throw new Error('permission denied');
      },
    };

    await expectTokenFailure(tokenPath, /cannot be read/u, fileSystem);
  });
});
