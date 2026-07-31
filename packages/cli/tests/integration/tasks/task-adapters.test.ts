import { afterAll, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTextFileReader } from '../../../src/adapters/tasks/bun-text-file-reader';
import { environmentBoardCredentials, environmentSessionId } from '../../../src/adapters/tasks/task-environment';

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
