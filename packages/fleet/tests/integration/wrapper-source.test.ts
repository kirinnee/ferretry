/** Reading a generated wrapper from a real filesystem, in a temporary directory this test created. */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { readFleetWrapperScript } from '../../src/adapters/wrapper-source.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-wrapper-source-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('readFleetWrapperScript', () => {
  it('should read a wrapper that is there', async () => {
    // Arrange
    const wrapper = path.join(await temporaryDirectory(), 'wrapper');
    await writeFile(wrapper, '#!/bin/sh\nexport A="${B}"\n');

    // Act / Assert
    should(await readFleetWrapperScript(wrapper)).equal('#!/bin/sh\nexport A="${B}"\n');
  });

  it('should yield nothing for a wrapper that is absent', async () => {
    should(await readFleetWrapperScript(path.join(await temporaryDirectory(), 'absent'))).be.undefined();
  });

  it('should yield nothing for a wrapper that cannot be read', async () => {
    // A directory exists to `Bun.file` callers only as a read that throws, which is the catch.
    const directory = await temporaryDirectory();
    should(await readFleetWrapperScript(path.join(directory, '\0'))).be.undefined();
  });
});
