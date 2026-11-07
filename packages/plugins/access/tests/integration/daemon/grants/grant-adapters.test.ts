import { describe, it } from 'bun:test';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import type { MemoryStateFolder } from '@ferretry/kernel/testing';
import { journalState } from '../../../support/daemon/journal-state.ts';
import should from 'should';
import { DevicesFile, GrantAuditFile } from '../../../../contract/index.ts';
import { JournalGrantAudit } from '../../../../daemon/adapters/grants/index.ts';

/**
 * The grant journal (`grant-audit.jsonl`) over the kernel's state port. The daemon-wide grant document is Gate's
 * (`gate.yaml`) and is tested there; this file holds Access's journal and the device-grant file's closed reading.
 */

/** One in-memory `state/access/`, so what the assertions read is what actually reached a file. */
function folder() {
  const { folder: files, state } = journalState();
  return { files, state };
}

/** Every line the journal holds, parsed. */
const lines = (files: MemoryStateFolder): Record<string, unknown>[] =>
  (files.raw(GrantAuditFile) ?? '')
    .trim()
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);

/** A journal line as another writer would have appended it. */
const line = (kind: string, at: string, actor: string, changes: readonly string[]) =>
  `${JSON.stringify({ format: 1, kind, at, actor, changes })}\n`;

describe('the grant journal', () => {
  it('G150 should record a grant change with the actor and the axes, and never a credential', async () => {
    // "When did this machine start letting a phone apply the fleet, and who said so" becomes
    // unanswerable at exactly the moment somebody needs it answered, unless it is written down.
    // Arrange
    const { files, state } = folder();
    const audit = new JournalGrantAudit(state);

    // Act
    await audit.record({
      actor: 'device:phone-1',
      changes: ['fleet.configure=off'],
      at: '2026-08-05T10:00:00.000Z',
    });

    // Assert
    should(lines(files)).deepEqual([
      {
        format: 1,
        kind: 'grant.changed',
        at: '2026-08-05T10:00:00.000Z',
        actor: 'device:phone-1',
        changes: ['fleet.configure=off'],
      },
    ]);
    should(files.raw(GrantAuditFile)).not.match(/Bearer|token/iu);
  });

  it('should answer an absent journal as an empty history, not as a failure', async () => {
    // Nothing has ever been changed on a fresh machine. That is a real answer.
    // Act
    const read = await new JournalGrantAudit(folder().state).recent(10);

    // Assert
    should(read).deepEqual({ entries: [], unreadable: 0, truncated: false });
  });

  it('should return the most recent first and stop at the limit', async () => {
    // Arrange
    const { files, state } = folder();
    files.plant(
      GrantAuditFile,
      [
        line('grant.changed', '2026-08-05T09:00:00.000Z', 'admin-cli', ['fleet.use=off']),
        line('grant.changed', '2026-08-05T10:00:00.000Z', 'device:phone-1', ['fleet.use=on']),
        line('grant.changed', '2026-08-05T11:00:00.000Z', 'admin-ui', ['warden.configure=off']),
      ].join(''),
    );

    // Act
    const read = await new JournalGrantAudit(state).recent(2);

    // Assert
    should(read.entries.map(entry => entry.actor)).deepEqual(['admin-ui', 'device:phone-1']);
    should(read.truncated).be.false();
  });

  it('should count a damaged line and preserve the surviving history', async () => {
    // Damage is counted and reported beside the surviving entries, as in today's bounded journal reader.
    // Arrange
    const { files, state } = folder();
    files.plant(
      GrantAuditFile,
      `${line('grant.changed', '2026-08-05T09:00:00.000Z', 'admin-cli', ['fleet.use=off'])}{"format":1,"kind":"grant.changed","at":"2026\n`,
    );

    // Act + Assert
    const read = await new JournalGrantAudit(state).recent(10);
    should(read.entries).have.length(1);
    should(read.unreadable).equal(1);
    should(read.truncated).be.false();
  });
});

describe('the journal kind', () => {
  it('should write and read the security journal under its own kind', async () => {
    // One kind per record, so a reader never mistakes one history for the other.
    // Arrange
    const { files, state } = folder();
    const audit = new JournalGrantAudit(state, 'security.changed');

    // Act
    await audit.record({
      actor: 'device:phone-1',
      changes: ['security.idleExpiryDays=40->10'],
      at: '2026-10-01T10:00:00.000Z',
    });
    const read = await audit.recent(10);

    // Assert
    should(lines(files)).deepEqual([
      {
        format: 1,
        kind: 'security.changed',
        at: '2026-10-01T10:00:00.000Z',
        actor: 'device:phone-1',
        changes: ['security.idleExpiryDays=40->10'],
      },
    ]);
    should(read.entries).deepEqual([
      { at: '2026-10-01T10:00:00.000Z', actor: 'device:phone-1', changes: ['security.idleExpiryDays=40->10'] },
    ]);
    should(read.unreadable).equal(0);
  });

  it('should let one entry override the journal kind, as `device.key-rotated` does', async () => {
    // Arrange
    const { files, state } = folder();
    const audit = new JournalGrantAudit(state, 'security.changed');

    // Act
    await audit.record({
      actor: 'device:phone-1',
      changes: ['device.key-rotated'],
      at: '2026-10-01T10:00:00.000Z',
      kind: 'device.key-rotated',
    });
    await audit.record({
      actor: 'admin-cli',
      changes: ['security.unlockOnOpen=true->false'],
      at: '2026-10-01T11:00:00.000Z',
    });

    // Assert — each line carries its own kind.
    should(lines(files).map(entry => entry.kind)).deepEqual(['device.key-rotated', 'security.changed']);
  });

  it('should have each reader skip every record of another kind', async () => {
    // A foreign kind is not this journal's history.
    // Arrange
    const { files, state } = folder();
    files.plant(
      GrantAuditFile,
      [
        line('security.changed', '2026-10-01T10:00:00.000Z', 'a', ['x']),
        line('grant.changed', '2026-10-01T11:00:00.000Z', 'b', ['fleet.use=off']),
      ].join(''),
    );

    // Act
    const grants = await new JournalGrantAudit(state).recent(10);
    const security = await new JournalGrantAudit(state, 'security.changed').recent(10);

    // Assert
    should(grants.entries.map(entry => entry.actor)).deepEqual(['b']);
    should(security.entries.map(entry => entry.actor)).deepEqual(['a']);
  });

  it('should keep the grant kind as the default when no kind is given', async () => {
    // Arrange
    const { files, state } = folder();

    // Act
    await new JournalGrantAudit(state).record({
      actor: 'a',
      changes: [],
      at: '2026-10-01T10:00:00.000Z',
    });

    // Assert
    should(lines(files)[0]?.kind).equal('grant.changed');
  });
});

describe('the device grants file', () => {
  const daemonId = `fy_daemon_${'a'.repeat(43)}`;
  const device = (grants: unknown) => ({
    id: `fy_device_id_${'b'.repeat(22)}`,
    daemonId,
    name: 'iPad',
    platform: 'browser',
    createdAt: '2026-08-01T09:00:00.000Z',
    lastSeenAt: '2026-08-03T11:58:00.000Z',
    publicKey: 'MCowBQYDK2VwAyEA',
    ...(grants === undefined ? {} : { grants }),
  });
  const planted = (grants: unknown) => {
    const { files, state } = folder();
    files.plant(DevicesFile, JSON.stringify({ format: 1, daemonId, devices: [device(grants)] }));
    return state;
  };

  it('G141 should fail the whole document closed on a malformed grants field, and never fill a missing one', async () => {
    // Act
    const whole = await planted(FULL_DEVICE_GRANTS).read(DevicesFile);
    const malformed = await planted({ ...FULL_DEVICE_GRANTS, terminal: { use: 'yes', configure: false } }).read(
      DevicesFile,
    );
    const partial = await planted({ fleet: { use: true, configure: false } }).read(DevicesFile);
    const missing = await planted(undefined).read(DevicesFile);

    // Assert — damaged state is never read as empty, and nothing is defaulted in
    should(whole.ok).be.true();
    for (const read of [malformed, partial, missing]) {
      should(read.ok).be.false();
      if (!read.ok) should(read.error.reason).equal('schema');
    }
  });
});
