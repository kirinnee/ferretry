import { afterAll, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTextFileReader } from '../../../src/adapters/tasks/bun-text-file-reader';
import { createFyClient, environmentSessionId } from '../../../src/adapters/tasks/fy-client-factory';

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

describe('resolving the daemon connection', () => {
  it('should build a client from FY_URL and FY_TOKEN', async () => {
    // Act
    const actual = await createFyClient({ FY_URL: 'http://127.0.0.1:65535', FY_TOKEN: 'secret' }, '1.0.0');

    // Assert
    should(actual).have.property('request').which.is.a.Function();
  });

  it('should refuse to guess where the daemon is', async () => {
    // Act + Assert
    should(() => createFyClient({}, '1.0.0')).throw(/set FY_URL/u);
    should(() => createFyClient({ FY_URL: '   ' }, '1.0.0')).throw(/set FY_URL/u);
    should(() => createFyClient({ FY_URL: 'http://127.0.0.1:65535' }, '1.0.0')).throw(/set FY_TOKEN/u);
    should(() => createFyClient({ FY_URL: 'http://127.0.0.1:65535', FY_TOKEN: ' ' }, '1.0.0')).throw(/set FY_TOKEN/u);
  });

  it('should read the ambient session id, treating blank as absent', () => {
    // Act + Assert
    should(environmentSessionId({ FY_SESSION_ID: '  session-7  ' })).equal('session-7');
    should(environmentSessionId({ FY_SESSION_ID: '   ' })).be.undefined();
    should(environmentSessionId({})).be.undefined();
  });
});
