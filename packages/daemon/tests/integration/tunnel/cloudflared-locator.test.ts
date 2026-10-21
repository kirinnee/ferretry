/**
 * Where `cloudflared` is: a named override that must be runnable and does not fall back, else `PATH`.
 */

import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { CloudflaredLocator, isExecutableFile } from '../../../src/adapters/tunnel/cloudflared-locator.ts';
import { removeTempDirectories, tempDirectory } from './support.ts';

afterEach(removeTempDirectories);

async function executable(directory: string, name: string, mode = 0o755): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, mode);
  return path;
}

describe('the cloudflared locator', () => {
  it('should run the operator’s FY_CLOUDFLARED when it is an executable file', async () => {
    // Arrange
    const directory = await tempDirectory('cloudflared-override');
    const path = await executable(directory, 'my-cloudflared');

    // Act
    const location = new CloudflaredLocator({ FY_CLOUDFLARED: ` ${path} `, PATH: '' }).locate();

    // Assert
    should(location).deepEqual({ kind: 'found', path, via: 'override' });
  });

  it('should refuse an override that names nothing runnable, and not search PATH instead', async () => {
    // Arrange
    const directory = await tempDirectory('cloudflared-override');
    const notRunnable = await executable(directory, 'plain-file', 0o644);
    const onPath = await tempDirectory('cloudflared-path');
    await executable(onPath, 'cloudflared');

    // Act
    const located = [notRunnable, directory, join(directory, 'missing')].map(path =>
      new CloudflaredLocator({ FY_CLOUDFLARED: path, PATH: onPath }).locate(),
    );

    // Assert
    should(located.map(location => location.kind)).deepEqual(['absent', 'absent', 'absent']);
    should(located[0]).deepEqual({
      kind: 'absent',
      reason: `FY_CLOUDFLARED names ${notRunnable}, which is not an executable file`,
    });
  });

  it('should search the daemon’s PATH when no override is set', async () => {
    // Arrange
    const onPath = await tempDirectory('cloudflared-path');
    const path = await executable(onPath, 'cloudflared');
    const empty = await tempDirectory('cloudflared-empty');
    await mkdir(join(empty, 'nothing'));

    // Act
    const found = new CloudflaredLocator({ PATH: `${empty}:${onPath}`, FY_CLOUDFLARED: '  ' }).locate();
    const absent = new CloudflaredLocator({ PATH: empty }).locate();
    const noPath = new CloudflaredLocator({}).locate();

    // Assert
    should(found).deepEqual({ kind: 'found', path, via: 'path' });
    should(absent).deepEqual({ kind: 'absent', reason: 'cloudflared is not on this daemon’s PATH' });
    should(noPath.kind).equal('absent');
  });

  it('should only call a regular executable file executable', async () => {
    const directory = await tempDirectory('cloudflared-kind');
    should(isExecutableFile(await executable(directory, 'yes'))).be.true();
    should(isExecutableFile(directory)).be.false();
    should(isExecutableFile(join(directory, 'missing'))).be.false();
  });
});
