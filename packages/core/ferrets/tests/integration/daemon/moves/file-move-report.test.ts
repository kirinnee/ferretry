import { afterEach, describe, it } from 'bun:test';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileMigrationReportStore } from '../../../src/adapters/migrate/file-migration-report.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The migration report on a real filesystem.
 *
 * Everything here runs inside a throwaway directory: no state home is resolved and no session
 * directory outside the test's own temp tree is ever written.
 */

const ID = parseSessionId('session-1');

describe('FileMigrationReportStore', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('should write the report into the session directory and answer with its path', async () => {
    // The path is the return value because the handoff message names it: a store that decided the
    // location privately would leave the migrated agent pointed at a guess.
    // Arrange
    const home = await tempDirectory('migration-report');
    const directory = join(home, 'sessions', ID);
    const subject = new FileMigrationReportStore(() => directory);

    // Act
    const path = await subject.write(ID, '# Migration in-flight report\n');

    // Assert
    should(path).equal(join(directory, 'migration-inflight.md'));
    should(await readFile(path, 'utf8')).equal('# Migration in-flight report\n');
    // The directory is created on the way, so a session whose report is written before anything else
    // has ever touched its directory still gets one.
    should((await stat(directory)).isDirectory()).be.true();
  });

  it('should leave no temporary file behind, because the agent reads this directory', async () => {
    // The write is atomic through a rename, and the replacement agent is handed a path in this very
    // directory: a leftover `.tmp` beside the report is a second, half-written account of the same
    // migration sitting where a human looks for the real one.
    // Arrange
    const directory = await tempDirectory('migration-atomic');
    const subject = new FileMigrationReportStore(() => directory);

    // Act
    await subject.write(ID, 'first\n');

    // Assert
    should(await readdir(directory)).deepEqual(['migration-inflight.md']);
  });

  it('should append the outcome rather than rewrite the inventory it settles', async () => {
    // By the time the outcome is known the pane is gone, so the inventory above it is the only
    // surviving account of what the kill destroyed. A rewrite that failed part-way would take it.
    // Arrange
    const directory = await tempDirectory('migration-outcome');
    const subject = new FileMigrationReportStore(() => directory);
    await subject.write(ID, '# Migration in-flight report\n\n- Session: `session-1`\n');

    // Act
    await subject.append(ID, '\n## Outcome — MIGRATION SUCCEEDED\n');

    // Assert
    should(await readFile(subject.file(ID), 'utf8')).equal(
      '# Migration in-flight report\n\n- Session: `session-1`\n\n## Outcome — MIGRATION SUCCEEDED\n',
    );
  });

  it('should replace an earlier report when a session is migrated a second time', async () => {
    // ONE report per session: the handoff message can only name one file, and a numbered pile in the
    // session directory would grow for as long as the session lives. The journal keeps both moves.
    // Arrange
    const directory = await tempDirectory('migration-second');
    const subject = new FileMigrationReportStore(() => directory);
    await subject.write(ID, 'first move\n');
    await subject.append(ID, 'first outcome\n');

    // Act
    await subject.write(ID, 'second move\n');

    // Assert
    should(await readFile(subject.file(ID), 'utf8')).equal('second move\n');
  });

  it('should keep the report private to the user the daemon runs as', async () => {
    // It quotes the argv of everything that was running in the pane, including whatever a command
    // line happened to carry.
    // Arrange
    const directory = await tempDirectory('migration-mode');
    const subject = new FileMigrationReportStore(() => directory);

    // Act
    const path = await subject.write(ID, 'sensitive argv\n');

    // Assert
    should((await stat(path)).mode & 0o777).equal(0o600);
  });
});
