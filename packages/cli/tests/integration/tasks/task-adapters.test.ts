import { afterAll, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTextFileReader } from '../../../src/adapters/tasks/bun-text-file-reader';
import {
  createFyClient,
  environmentBoardCredentials,
  environmentSessionId,
} from '../../../src/adapters/tasks/fy-client-factory';

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

  it('should collect the board proofs the daemon exported', () => {
    // Act
    const actual = environmentBoardCredentials({
      FY_BOARD_CAPABILITY: ' peer ',
      FY_BOARD_ADMIN_CAPABILITY: 'admin',
      FY_SESSION_BOARD_CAPABILITY: 'session',
      FY_BOARD_INVITATION_CAPABILITY: 'invite',
    });

    // Assert
    should(actual).eql({ peer: 'peer', admin: 'admin', session: 'session', invitation: 'invite' });
  });

  it('should report every board proof absent on a host that exported none', () => {
    // Act — kteam fell back to reading 0600 files under its state home; this CLI deliberately does not.
    const actual = environmentBoardCredentials({ FY_BOARD_CAPABILITY: '   ' });

    // Assert
    should(actual).eql({ peer: undefined, admin: undefined, session: undefined, invitation: undefined });
  });
});
