import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AcceptedConfigFiles } from '@ferretry/fleet';
import type { ConfigChangeKind } from '@ferretry/protocol';
import should from 'should';
import {
  type ConfigChange,
  ConfigChangeLedger,
  ConfigFilesService,
  changedConfigPaths,
} from '../../../src/lib/config-files/index.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A scheduler a test fires by hand. */
class ManualScheduler {
  readonly pending: { readonly milliseconds: number; readonly action: () => void }[] = [];

  after(milliseconds: number, action: () => void): void {
    this.pending.push({ milliseconds, action });
  }

  fire(): void {
    const due = this.pending.splice(0);
    for (const entry of due) entry.action();
  }
}

const ledger = () => {
  const scheduler = new ManualScheduler();
  const subject = new ConfigChangeLedger('boot-1', scheduler);
  const heard: ConfigChange[] = [];
  subject.subscribe(change => heard.push(change));
  return { scheduler, subject, heard };
};

/** A configuration service over an in-memory directory, with every announcement recorded. */
const service = (files: Record<string, string>) => {
  const disk = new Map(Object.entries(files));
  let accepted: AcceptedConfigFiles = {};
  const announced: (readonly ConfigChangeKind[])[] = [];
  const subject = new ConfigFilesService({
    directory: {
      directory: '/home/owner/.fy/config',
      list: async () => ({ files: [...disk].map(([path, text]) => ({ path, text })), unreadable: [] }),
      fingerprint: async () => [...disk].map(([path, text]) => `${path}:${digest(text)}`).join('\n'),
      read: async path => disk.get(path),
      write: async (path, text) => {
        disk.set(path, text);
      },
      remove: async path => {
        disk.delete(path);
      },
      writeSchemas: async () => undefined,
    },
    accepted: {
      read: async () => accepted,
      write: async next => {
        accepted = next;
      },
    },
    log: { issue: () => undefined, pending: () => undefined },
    digest,
    now: () => new Date('2026-10-18T09:00:00.000Z'),
    changes: { announce: kinds => announced.push(kinds) },
  });
  return { disk, subject, announced };
};

describe('ConfigChangeLedger', () => {
  it('should start at revision zero in its own epoch', () => {
    // Arrange
    const { subject } = ledger();

    // Act
    const current = subject.current();

    // Assert
    should(current).deepEqual({ epoch: 'boot-1', revision: 0 });
  });

  it('should merge announcements inside one window into one revision naming every kind', () => {
    // Arrange
    const { scheduler, subject, heard } = ledger();

    // Act — an apply, the read after it, and the watcher all announce the same act.
    subject.announce(['runtimes']);
    subject.announce(['files', 'runtimes']);
    subject.announce(['credentials']);
    scheduler.fire();

    // Assert — one timer, one revision, the kinds in the protocol's own order.
    should(heard).deepEqual([{ epoch: 'boot-1', revision: 1, kinds: ['files', 'credentials', 'runtimes'] }]);
    should(subject.current().revision).equal(1);
  });

  it('should arm one timer per window and a fresh one after it fired', () => {
    // Arrange
    const { scheduler, subject, heard } = ledger();

    // Act
    subject.announce(['warden']);
    subject.announce(['warden']);
    const armedOnce = scheduler.pending.length;
    scheduler.fire();
    subject.announce(['voice']);
    scheduler.fire();

    // Assert
    should(armedOnce).equal(1);
    should(heard.map(change => [change.revision, change.kinds])).deepEqual([
      [1, ['warden']],
      [2, ['voice']],
    ]);
  });

  it('should count nothing for an announcement that names no kind', () => {
    // Arrange
    const { scheduler, subject } = ledger();

    // Act
    subject.announce([]);

    // Assert
    should(scheduler.pending).be.empty();
    should(subject.current().revision).equal(0);
  });

  it('should still tell every other reader when one throws, and stop telling one that left', () => {
    // Arrange
    const { scheduler, subject, heard } = ledger();
    subject.subscribe(() => {
      throw new Error('a broken reader');
    });
    const left: ConfigChange[] = [];
    const leave = subject.subscribe(change => left.push(change));
    leave();

    // Act
    subject.announce(['machine']);
    scheduler.fire();

    // Assert
    should(heard).have.length(1);
    should(left).be.empty();
  });
});

describe('changedConfigPaths', () => {
  it('should name exactly the paths a hand edit, a new file and a removed file touched', async () => {
    // Arrange
    const { disk, subject } = service({
      'warden.yaml': 'triage: rules\n',
      'learning.yaml': 'enabled: false\n',
      'voice.yaml': 'engine: browser\n',
    });
    const before = await subject.load();
    disk.set('warden.yaml', 'triage: llm\n');
    disk.delete('voice.yaml');
    disk.set('runtimes/work.yaml', 'nonsense: [\n');

    // Act
    const after = await subject.load();

    // Assert — learning.yaml did not move, so it is not named.
    should(changedConfigPaths(before, after)).deepEqual(['runtimes/work.yaml', 'voice.yaml', 'warden.yaml']);
    should(changedConfigPaths(after, after)).be.empty();
  });
});

describe('ConfigFilesService announcing what a load found changed', () => {
  it('should announce nothing for the first load, which is the baseline', async () => {
    // Arrange
    const { subject, announced } = service({ 'warden.yaml': 'triage: rules\n' });

    // Act
    await subject.load();

    // Assert
    should(announced).be.empty();
  });

  it('should announce nothing when a load finds what the last one did', async () => {
    // Arrange
    const { subject, announced } = service({ 'warden.yaml': 'triage: rules\n' });
    await subject.load();

    // Act — every read loads, so most loads find nothing new.
    await subject.load();
    await subject.status();

    // Assert
    should(announced).be.empty();
  });

  it('should announce the kinds a hand-edited file feeds, whoever edited it', async () => {
    // Arrange
    const { disk, subject, announced } = service({ 'warden.yaml': 'triage: rules\n' });
    await subject.load();

    // Act — a hand edit the watcher found, then a new runtime written by `fy`.
    disk.set('warden.yaml', 'triage: llm\n');
    await subject.load();
    disk.set('runtimes/work.yaml', 'harness: claude\n');
    await subject.load();

    // Assert
    should(announced).deepEqual([
      ['files', 'warden'],
      ['files', 'runtimes'],
    ]);
  });
});
