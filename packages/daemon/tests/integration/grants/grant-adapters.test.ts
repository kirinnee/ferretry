import { describe, it } from 'bun:test';
import { DAEMON_CAPABILITIES } from '@ferretry/protocol';
import should from 'should';
import {
  ConfigGrantDocument,
  FileOperatorPassword,
  JournalGrantAudit,
  RandomUnlockTokens,
  SystemGrantClock,
} from '../../../src/adapters/grants/index.ts';
import { FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import { DEFAULT_CAPABILITY_GRANTS, type FileSystemPort, type FoundationPaths } from '../../../src/lib/index.ts';

const paths = {
  daemonConfig: '/state/config/daemon.json',
  operatorPassword: '/state/state/operator-password.json',
  grantAudit: '/state/state/grant-audit.jsonl',
} as FoundationPaths;

/** One in-memory tree, so what the assertions read is what actually reached a file. */
function tree(initial: Readonly<Record<string, string>> = {}) {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  const appended: string[] = [];
  const port = {
    readText: async (path: string) => files.get(path),
    writeTextAtomic: async (path: string, next: string) => {
      files.set(path, next);
    },
    setMode: async (path: string, mode: number) => {
      modes.set(path, mode);
    },
    appendLineDurable: async (path: string, line: string) => {
      appended.push(line);
      files.set(path, `${files.get(path) ?? ''}${line}\n`);
      return { offset: 0, fingerprint: { device: 0, inode: 0 } };
    },
  } as unknown as FileSystemPort;
  return { port, files, modes, appended };
}

/** Each direct adapter world owns the same transaction boundary production supplies at composition. */
function grantDocument(config: FileDaemonConfig): ConfigGrantDocument {
  return new ConfigGrantDocument(config, new KeyedSerialExecutor());
}

describe('the grants in the operator configuration document', () => {
  it('should answer a document that never mentions grants with the product defaults', async () => {
    // Silence is a complete answer: an operator who has never thought about this gets the permissive
    // behaviour the product promises, and the report says the value came from the default.
    // Arrange
    const world = tree();
    const document = grantDocument(new FileDaemonConfig(paths, world.port));

    // Act
    const grants = await document.read();
    const written = await document.written();

    // Assert
    should(grants).deepEqual(DEFAULT_CAPABILITY_GRANTS);
    should(written).be.empty();
  });

  it('should report exactly the capabilities the operator wrote down', async () => {
    // Provenance cannot be recovered by comparison — an operator may write a value identical to the
    // default — so it is read from what is actually on disk.
    // Arrange
    const world = tree({
      [paths.daemonConfig]: JSON.stringify({ grants: { warden: { configure: false }, fleet: { use: true } } }),
    });
    const document = grantDocument(new FileDaemonConfig(paths, world.port));

    // Act
    const written = await document.written();
    const grants = await document.read();

    // Assert — `fleet.use: true` is the same as the default and is still reported as written down.
    should([...written].sort()).deepEqual(['fleet', 'warden']);
    should(grants.warden).deepEqual({ use: true, configure: false });
    should(grants.terminal).deepEqual(DEFAULT_CAPABILITY_GRANTS.terminal);
  });

  it('should refuse a grant document that is wrong rather than falling back to anything', async () => {
    // Silence and damage are different things. A document naming a capability this daemon does not
    // have, or a string where a boolean belongs, is damage — and unknown is never permitted.
    // Arrange
    const unknown = grantDocument(
      new FileDaemonConfig(paths, tree({ [paths.daemonConfig]: JSON.stringify({ grants: { kubernetes: {} } }) }).port),
    );
    const wrongType = grantDocument(
      new FileDaemonConfig(
        paths,
        tree({ [paths.daemonConfig]: JSON.stringify({ grants: { warden: { use: 'yes' } } }) }).port,
      ),
    );

    // Act + Assert
    await should(unknown.read()).be.rejected();
    await should(wrongType.read()).be.rejected();
  });

  it('should write exactly one key, leaving an operator’s own fields untouched', async () => {
    // The same discipline `record` follows: a write this daemon makes must not rewrite a document
    // from a parsed configuration, because that persists derived values which then stop tracking
    // what they were derived from.
    // Arrange
    const world = tree({
      [paths.daemonConfig]: JSON.stringify({ host: '0.0.0.0', port: 9_000, projectRoots: ['~/w'] }),
    });
    const document = grantDocument(new FileDaemonConfig(paths, world.port));

    // Act
    await document.write({ ...DEFAULT_CAPABILITY_GRANTS, warden: { use: false, configure: false } });
    const saved = JSON.parse(world.files.get(paths.daemonConfig) ?? '{}') as Record<string, unknown>;

    // Assert
    should(saved).have.property('host', '0.0.0.0');
    should(saved).have.property('port', 9_000);
    should(saved).have.property('projectRoots').deepEqual(['~/w']);
    should((saved.grants as Record<string, unknown>).warden).deepEqual({ use: false, configure: false });
    should(saved).not.have.property('bindUrl');
    should(saved).not.have.property('publicUrl');
  });

  it('should treat a null grants key as unwritten rather than crashing on it', async () => {
    // Arrange
    const world = tree({ [paths.daemonConfig]: JSON.stringify({ grants: null }) });

    // Act
    const written = await new FileDaemonConfig(paths, world.port).writtenGrants();

    // Assert
    should(written).be.empty();
  });
});

describe('the operator password verifier', () => {
  it('should store an argon2id digest, never the password, at mode 0600', async () => {
    // The threat is somebody with a copy of the state home guessing offline, and against that a fast
    // digest buys almost nothing — the cost of guessing is what makes a human-chosen password
    // survivable at all.
    // Arrange
    const world = tree();
    const passwords = new FileOperatorPassword(paths.operatorPassword, world.port);

    // Act
    await passwords.set('correct horse battery staple');
    const stored = world.files.get(paths.operatorPassword) ?? '';

    // Assert
    should(stored).not.match(/correct horse/u);
    should(stored).match(/\$argon2id\$/u);
    should(world.modes.get(paths.operatorPassword)).equal(0o600);
    should(await passwords.isSet()).be.true();
  });

  it('should verify the right password and refuse a wrong one', async () => {
    // Arrange
    const world = tree();
    const passwords = new FileOperatorPassword(paths.operatorPassword, world.port);
    await passwords.set('correct horse battery staple');

    // Act + Assert
    should(await passwords.verify('correct horse battery staple')).be.true();
    should(await passwords.verify('correct horse battery stapl')).be.false();
  });

  it('should answer false rather than true on a machine with no verifier', async () => {
    // "There is nothing to check" must never become "so everything passes". The caller above decides
    // what an absent password means, in one place.
    // Arrange
    const passwords = new FileOperatorPassword(paths.operatorPassword, tree().port);

    // Act + Assert
    should(await passwords.isSet()).be.false();
    should(await passwords.verify('anything')).be.false();
  });

  it('should keep a verifier on disk through every write, offering nothing that removes one', async () => {
    // THE MISSING METHOD IS THE CONTRACT. Removing a verifier revokes no paired device, so it would
    // leave a machine with devices paired and nothing gating them — the state pairing exists to make
    // unreachable. This asserts the shape rather than trusting the absence: every write this adapter
    // can perform leaves a password set.
    // Arrange
    const world = tree();
    const passwords = new FileOperatorPassword(paths.operatorPassword, world.port);

    // Act
    await passwords.set('operator-secret');
    await passwords.set('the-replacement');

    // Assert
    should(await passwords.isSet()).be.true();
    should(await passwords.verify('the-replacement')).be.true();
    should(await passwords.verify('operator-secret')).be.false();
    should(passwords).not.have.property('clear');
  });

  it('should read a passwordless file written by an earlier daemon as an ABSENCE, not as damage', async () => {
    // `{}` is what removing a password used to leave behind. The verb is gone, but the file is not: a
    // machine that ran an older daemon still has one, and it must come up passwordless rather than
    // refusing every governed capability as undetermined.
    // Arrange
    const world = tree();
    world.files.set(paths.operatorPassword, '{}\n');
    const passwords = new FileOperatorPassword(paths.operatorPassword, world.port);

    // Act + Assert
    should(await passwords.isSet()).be.false();
    should(await passwords.verify('anything')).be.false();
  });

  it('should RAISE on a damaged verifier rather than reading it as absent', async () => {
    // Reading damage as absence would silently disarm the security layer on the one machine whose
    // state is already known to be damaged — and the operator would never be told.
    // Arrange
    const damaged = new FileOperatorPassword(
      paths.operatorPassword,
      tree({ [paths.operatorPassword]: '{"argon2id":123}' }).port,
    );

    // Act + Assert
    await should(damaged.isSet()).be.rejected();
  });

  it('should let its hashing be substituted so a test never pays argon2id twice', async () => {
    // Arrange
    const world = tree();
    const passwords = new FileOperatorPassword(
      paths.operatorPassword,
      world.port,
      async password => `fake:${password}`,
      async (password, digest) => digest === `fake:${password}`,
    );

    // Act
    await passwords.set('operator-secret');

    // Assert
    should(await passwords.verify('operator-secret')).be.true();
    should(await passwords.verify('other')).be.false();
  });
});

describe('the remaining grant ports', () => {
  it('should mint prefixed, high-entropy unlocks that are not derived from anything', async () => {
    // An unlock that leaked must say nothing about the password behind it. The prefix is not the
    // secret — it is what makes one greppable in a support thread.
    // Act
    const minted = new Set(Array.from({ length: 64 }, () => new RandomUnlockTokens().mint()));

    // Assert
    should(minted.size).equal(64);
    for (const token of minted) should(token).match(/^fy_unlock_[A-Za-z0-9_-]{22,}$/u);
  });

  it('should record a grant change with the actor and the axes, and never a credential', async () => {
    // "When did this machine start letting a phone apply the fleet, and who said so" becomes
    // unanswerable at exactly the moment somebody needs it answered, unless it is written down.
    // Arrange
    const world = tree();
    const audit = new JournalGrantAudit(paths.grantAudit, world.port);

    // Act
    await audit.record({
      actor: 'device:phone-1',
      changes: ['fleet.configure=off'],
      at: '2026-08-05T10:00:00.000Z',
    });

    // Assert
    should(JSON.parse(world.appended[0] ?? '{}')).deepEqual({
      kind: 'grant.changed',
      at: '2026-08-05T10:00:00.000Z',
      actor: 'device:phone-1',
      changes: ['fleet.configure=off'],
    });
    should(world.appended[0]).not.match(/Bearer|token|password/iu);
  });

  it('should read wall-clock milliseconds through the clock port', () => {
    // Act
    const before = Date.now();
    const now = new SystemGrantClock().nowMs();

    // Assert
    should(now).be.aboveOrEqual(before);
  });

  it('should cover every capability the contract declares', async () => {
    // A document write must name all five, or a later read would find a partial decision — the one
    // shape the enforcement path is built to make unrepresentable.
    // Arrange
    const world = tree();
    const document = grantDocument(new FileDaemonConfig(paths, world.port));

    // Act
    await document.write(DEFAULT_CAPABILITY_GRANTS);
    const saved = JSON.parse(world.files.get(paths.daemonConfig) ?? '{}') as { grants: Record<string, unknown> };

    // Assert
    should(Object.keys(saved.grants).sort()).deepEqual([...DAEMON_CAPABILITIES].sort());
  });
});

describe('reading the grant journal back', () => {
  /** A tree whose slice reads behave like a real file's, so the tail logic is actually exercised. */
  function journal(text: string) {
    const bytes = new TextEncoder().encode(text);
    const port = {
      information: async () => (text === '' ? undefined : { size: bytes.byteLength }),
      readSlice: async (_path: string, offset: number, length: number) => bytes.slice(offset, offset + length),
      appendLineDurable: async () => ({ offset: 0, fingerprint: { device: 0, inode: 0 } }),
    } as unknown as FileSystemPort;
    return new JournalGrantAudit(paths.grantAudit, port);
  }

  const line = (at: string, actor: string, changes: readonly string[]) =>
    `${JSON.stringify({ kind: 'grant.changed', at, actor, changes })}\n`;

  it('should answer an absent journal as an empty history, not as a failure', async () => {
    // Nothing has ever been changed on a fresh machine. That is a real answer.
    // Act
    const read = await journal('').recent(10);

    // Assert
    should(read).deepEqual({ entries: [], unreadable: 0, truncated: false });
  });

  it('should return the most recent first and stop at the limit', async () => {
    // Arrange
    const text = [
      line('2026-08-05T09:00:00.000Z', 'admin-cli', ['fleet.use=off']),
      line('2026-08-05T10:00:00.000Z', 'device:phone-1', ['fleet.use=on']),
      line('2026-08-05T11:00:00.000Z', 'admin-ui', ['warden.configure=off']),
    ].join('');

    // Act
    const read = await journal(text).recent(2);

    // Assert
    should(read.entries.map(entry => entry.actor)).deepEqual(['admin-ui', 'device:phone-1']);
    should(read.truncated).be.false();
  });

  it('should COUNT a line it cannot read rather than dropping it', async () => {
    // Silently skipping damage would let a truncated or tampered journal read as a clean history —
    // the absent-evidence-as-benign-result defect this product has been bitten by repeatedly.
    // Arrange — a torn line, a foreign record, and one whose fields are the wrong shape.
    const text = [
      line('2026-08-05T09:00:00.000Z', 'admin-cli', ['fleet.use=off']),
      '{"kind":"grant.changed","at":"2026\n',
      '{"kind":"session.started","at":"2026-08-05T09:30:00.000Z"}\n',
      '{"kind":"grant.changed","at":"2026-08-05T09:40:00.000Z","actor":"","changes":[]}\n',
      '{"kind":"grant.changed","at":"2026-08-05T09:45:00.000Z","actor":"a","changes":[7]}\n',
    ].join('');

    // Act
    const read = await journal(text).recent(10);

    // Assert — one good record survives and every bad line is reported.
    should(read.entries).have.length(1);
    should(read.unreadable).equal(4);
  });

  it('should never fabricate a record out of a half line at the window edge', async () => {
    // A window that opens mid-record must drop that fragment. Parsing half a record into a whole one
    // would invent history, which is worse than losing it — and it is not damage, so it is not
    // counted as damage either.
    // Arrange — a journal far larger than the 64 KiB window, so the window certainly opens mid-line.
    const filler = Array.from({ length: 2_000 }, (_unused, index) =>
      line(`2026-08-05T09:00:00.000Z`, `device:filler-${String(index).padStart(40, '0')}`, ['fleet.use=off']),
    ).join('');
    const text = `${filler}${line('2026-08-05T12:00:00.000Z', 'admin-cli', ['warden.use=off'])}`;

    // Act
    const read = await journal(text).recent(3);

    // Assert — the newest record is intact, and the truncation is declared rather than hidden.
    should(read.entries[0]).containDeep({ actor: 'admin-cli', changes: ['warden.use=off'] });
    should(read.truncated).be.true();
    should(read.unreadable).equal(0);
  });

  it('should report a slice it could not read as an empty window rather than as history', async () => {
    // Arrange — a file whose size is known but whose bytes will not come back.
    const port = {
      information: async () => ({ size: 100 }),
      readSlice: async () => undefined,
    } as unknown as FileSystemPort;

    // Act
    const read = await new JournalGrantAudit(paths.grantAudit, port).recent(10);

    // Assert
    should(read).deepEqual({ entries: [], unreadable: 0, truncated: false });
  });
});
