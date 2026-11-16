import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { MoveInflightFiles } from '../../../../contract/move-state.ts';
import { StateMoveReportStore } from '../../../../daemon/adapters/moves/state-move-report.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';

/**
 * The move report in the ferret's state folder, over the kernel's in-memory state: the report is a declared opaque
 * file (`MoveInflightFiles`), written whole by the kernel, so what is measured here is the two-halves contract and the
 * path the replacement agent is handed.
 */

const ID = parseSessionId('session-1');

function storeOver(): { readonly folder: MemoryStateFolder; readonly subject: StateMoveReportStore } {
  const folder = new MemoryStateFolder();
  return { folder, subject: new StateMoveReportStore(folder.port([MoveInflightFiles])) };
}

const text = (folder: MemoryStateFolder): string | undefined => {
  const bytes = folder.rawBytes(MoveInflightFiles, ID);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

describe('StateMoveReportStore', () => {
  it('should write the report into the ferret folder and answer with its path', async () => {
    // The path is the return value because the handoff message names it: a store that decided the
    // location privately would leave the moved agent pointed at a guess.
    // Arrange
    const { folder, subject } = storeOver();

    // Act
    const path = await subject.write(ID, '# Move in-flight report\n');

    // Assert
    should(path).equal(subject.file(ID));
    should(path.endsWith('session-1/move-inflight.md')).be.true();
    should(text(folder)).equal('# Move in-flight report\n');
  });

  it('should append the outcome rather than lose the inventory it settles', async () => {
    // By the time the outcome is known the pane is gone, so the inventory above it is the only
    // surviving account of what the kill destroyed.
    // Arrange
    const { folder, subject } = storeOver();
    await subject.write(ID, '# Move in-flight report\n\n- Session: `session-1`\n');

    // Act
    await subject.append(ID, '\n## Outcome — MOVE SUCCEEDED\n');

    // Assert
    should(text(folder)).equal('# Move in-flight report\n\n- Session: `session-1`\n\n## Outcome — MOVE SUCCEEDED\n');
  });

  it('should create the report from the outcome alone when no inventory was written, as an append to a missing file did', async () => {
    // Arrange
    const { folder, subject } = storeOver();

    // Act
    await subject.append(ID, 'outcome only\n');

    // Assert
    should(text(folder)).equal('outcome only\n');
  });

  it('should replace an earlier report when a session is moved a second time', async () => {
    // ONE report per session: the handoff message can only name one file, and a numbered pile in the
    // session directory would grow for as long as the session lives. The journal keeps both moves.
    // Arrange
    const { folder, subject } = storeOver();
    await subject.write(ID, 'first move\n');
    await subject.append(ID, 'first outcome\n');

    // Act
    await subject.write(ID, 'second move\n');

    // Assert
    should(text(folder)).equal('second move\n');
  });

  it('should keep each ferret its own report', async () => {
    // Arrange
    const { folder, subject } = storeOver();
    const other = parseSessionId('session-2');

    // Act
    await subject.write(ID, 'one\n');
    await subject.write(other, 'two\n');

    // Assert
    should(text(folder)).equal('one\n');
    should(new TextDecoder().decode(folder.rawBytes(MoveInflightFiles, other))).equal('two\n');
    should(subject.file(ID)).not.equal(subject.file(other));
  });
});
