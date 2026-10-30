import { afterAll, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTextFileReader } from '../../../src/adapters/tasks/bun-text-file-reader';
import { environmentSessionId } from '../../../src/adapters/tasks/task-environment';

const workspace = await mkdtemp(join(tmpdir(), 'fy-task-adapters-'));

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('reading a brief from disk', () => {
  it('should return the file contents verbatim', async () => {
    // Arrange
    const path = join(workspace, 'brief.md');
    await writeFile(path, '# Brief\n\nrename it\n');

    // Act
    const actual = await new BunTextFileReader().readText(path);

    // Assert
    should(actual).equal('# Brief\n\nrename it\n');
  });

  it('should name the file it could not read', async () => {
    // Act
    const failure = new BunTextFileReader().readText(join(workspace, 'absent.md'));

    // Assert
    await should(failure).be.rejectedWith(/cannot read .*absent\.md/u);
  });
});

describe('reading the task environment', () => {
  it('should read the ambient session id, treating blank as absent', () => {
    // Act + Assert
    should(environmentSessionId({ FY_SESSION_ID: '  session-7  ' })).equal('session-7');
    should(environmentSessionId({ FY_SESSION_ID: '   ' })).be.undefined();
    should(environmentSessionId({})).be.undefined();
  });
});
