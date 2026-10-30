import { afterAll, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WardenJevCheck } from '@ferretry/protocol';
import should from 'should';
import { FileWardenJevCheckLog } from '../../../src/adapters/warden/index.ts';
import { createWardenPaths } from '../../../src/lib/warden/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');

const check = (at: string, overrides: Partial<WardenJevCheck> = {}): WardenJevCheck => ({
  at,
  sessionId: 's1',
  anomalyKind: 'sus_thinking',
  verdict: 'handed_on',
  why: 'unsure',
  route: 'investigation',
  confidence: 0.4,
  costUsd: 0.0004,
  ...overrides,
});

/** A fresh state home's Jev check directory, not created yet. */
async function checksHome(label: string): Promise<string> {
  return createWardenPaths(path.join(await tempDirectory(label), 'state')).jevChecks;
}

afterAll(cleanupTempDirectories);

describe('the Jev check record', () => {
  it('should read as empty before any check was written', async () => {
    // Arrange
    const directory = await checksHome('jev-checks-empty');

    // Act / Assert
    should(await new FileWardenJevCheckLog(directory, () => NOW).recent(10)).deepEqual([]);
  });

  it('should append a line per check to its UTC day, owner-only, and read them back newest first', async () => {
    // Arrange
    const directory = await checksHome('jev-checks-append');
    const log = new FileWardenJevCheckLog(directory, () => NOW);
    const yesterday = check('2026-10-29T23:59:00.000Z');
    const first = check('2026-10-30T00:01:00.000Z', { verdict: 'healthy', why: undefined, route: undefined });
    const second = check('2026-10-30T09:00:00.000Z');

    // Act
    for (const entry of [yesterday, first, second]) await log.append(entry);

    // Assert
    should((await readdir(directory)).toSorted()).deepEqual(['2026-10-29.jsonl', '2026-10-30.jsonl']);
    should((await stat(directory)).mode & 0o777).equal(0o700);
    should((await stat(path.join(directory, '2026-10-30.jsonl'))).mode & 0o777).equal(0o600);
    should((await readFile(path.join(directory, '2026-10-30.jsonl'), 'utf8')).split('\n')).have.length(3);
    should(await log.recent(10)).deepEqual([second, JSON.parse(JSON.stringify(first)), yesterday]);
    should(await log.recent(2)).deepEqual([second, JSON.parse(JSON.stringify(first))]);
  });

  it('should drop the days past the keep window on the next append', async () => {
    // Arrange
    const directory = await checksHome('jev-checks-rotate');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '2026-09-30.jsonl'), `${JSON.stringify(check('2026-09-30T08:00:00.000Z'))}\n`);
    await writeFile(path.join(directory, '2026-10-01.jsonl'), `${JSON.stringify(check('2026-10-01T08:00:00.000Z'))}\n`);
    await writeFile(path.join(directory, 'notes.txt'), 'the owner’s own file\n');

    // Act
    await new FileWardenJevCheckLog(directory, () => NOW).append(check('2026-10-30T12:00:00.000Z'));

    // Assert
    should((await readdir(directory)).toSorted()).deepEqual(['2026-10-01.jsonl', '2026-10-30.jsonl', 'notes.txt']);
  });

  it('should file a check whose time does not read under today', async () => {
    // Arrange: the schema never lets one through; the adapter still has to put it somewhere.
    const directory = await checksHome('jev-checks-undated');

    // Act
    await new FileWardenJevCheckLog(directory, () => NOW).append(check('not a time'));

    // Assert
    should(await readdir(directory)).deepEqual(['2026-10-30.jsonl']);
  });

  it('should read a day that is gone by the time it is read as nothing, and fail on one that cannot be read', async () => {
    // Arrange: a dangling link is listed and then missing; a directory is listed and cannot be read.
    const gone = await checksHome('jev-checks-gone');
    await mkdir(gone, { recursive: true });
    await symlink(path.join(gone, 'nowhere'), path.join(gone, '2026-10-30.jsonl'));
    const broken = await checksHome('jev-checks-broken');
    await mkdir(path.join(broken, '2026-10-30.jsonl'), { recursive: true });

    // Act / Assert
    should(await new FileWardenJevCheckLog(gone, () => NOW).recent(5)).deepEqual([]);
    await should(new FileWardenJevCheckLog(broken, () => NOW).recent(5)).be.rejected();
  });

  it('should fail, never pretend, when the directory is not one', async () => {
    // Arrange
    const directory = await checksHome('jev-checks-not-a-directory');
    await mkdir(path.dirname(directory), { recursive: true });
    await writeFile(directory, 'a file where the directory should be\n');

    // Act / Assert
    await should(new FileWardenJevCheckLog(directory, () => NOW).recent(5)).be.rejected();
    await should(
      new FileWardenJevCheckLog(directory, () => NOW).append(check('2026-10-30T12:00:00.000Z')),
    ).be.rejected();
  });
});
