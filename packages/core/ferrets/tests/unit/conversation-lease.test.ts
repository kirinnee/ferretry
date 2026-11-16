import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ConversationHolderStanding,
  type ConversationId,
  ConversationIdSchema,
  type ConversationLeaseClaim,
  type ConversationLeaseDisk,
  type ConversationLeaseFacts,
  ConversationLeaseHeldError,
  type ConversationLeaseRecord,
  ConversationLeaseRecordSchema,
  ConversationLeaseStore,
  conversationFromArguments,
  conversationLeaseRefusal,
  decideConversationLease,
  HISTORY_CLAIM_HELD_EXIT_CODE,
  type HistoryHarness,
  MAX_LEASE_BYTES,
} from '../../contract/conversation-lease.ts';

const CONVERSATION = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');
const OTHER = ConversationIdSchema.parse('1c8f5d2b-2e3a-4d4c-8b9f-8a7e6d5c4b32');

function lease(holder: ConversationLeaseRecord['holder'], conversation = CONVERSATION): ConversationLeaseRecord {
  return { v: 1, harness: 'claude', conversation, holder, since: '2026-10-13T14:02:09.000Z' };
}

function claim(holder: ConversationLeaseClaim['holder']): ConversationLeaseClaim {
  return { harness: 'claude', conversation: CONVERSATION, holder };
}

const alive = (start: number): ConversationLeaseFacts => ({ holderStart: start, holderSession: 'unknown' });

describe('the held status', () => {
  it('should be 75, the one status a wrapper turns into not launching', () => {
    // Assert
    should(HISTORY_CLAIM_HELD_EXIT_CODE).equal(75);
  });
});

describe('decideConversationLease', () => {
  it('should create a lease when nobody holds the conversation', () => {
    // Arrange
    const facts: ConversationLeaseFacts = { holderStart: undefined, holderSession: 'unknown' };

    // Act
    const decision = decideConversationLease(undefined, claim({ pid: 10 }), facts);

    // Assert
    should(decision).equal('create');
  });

  it('should renew a lease the same session already holds, whatever its pid', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5, session: 's-1' });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 99, session: 's-1' }), alive(5));

    // Assert
    should(decision).equal('renew');
  });

  it('should renew a lease the same running process already holds', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5 });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 10 }), alive(5));

    // Assert
    should(decision).equal('renew');
  });

  it('should never let two sessions of one daemon share a conversation through their common pid', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5, session: 's-1' });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 10, session: 's-2' }), {
      holderStart: 5,
      holderSession: 'live',
    });

    // Assert
    should(decision).equal('held');
  });

  it('should refuse a lease whose live process is another writer', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5 });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 11 }), alive(5));

    // Assert
    should(decision).equal('held');
  });

  it('should take over a lease whose holder process is gone', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5 });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 11 }), {
      holderStart: undefined,
      holderSession: 'unknown',
    });

    // Assert
    should(decision).equal('take-over');
  });

  it('should take over a lease whose pid now belongs to a different process', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5 });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 10 }), alive(6));

    // Assert
    should(decision).equal('take-over');
  });

  it('should hold a lease recorded with no start time while its pid is running', () => {
    // Arrange
    const existing = lease({ pid: 10 });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 11 }), alive(6));

    // Assert
    should(decision).equal('held');
  });

  it('should let a live holder session decide even when its pid is gone', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5, session: 's-1' });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 11, session: 's-2' }), {
      holderStart: undefined,
      holderSession: 'live',
    });

    // Assert
    should(decision).equal('held');
  });

  it('should take over from a holder session that is over even while its pid runs', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5, session: 's-1' });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 11, session: 's-2' }), {
      holderStart: 5,
      holderSession: 'over',
    });

    // Assert
    should(decision).equal('take-over');
  });

  it('should fall back to the pid for a holder session the claimant cannot judge', () => {
    // Arrange
    const existing = lease({ pid: 10, start: 5, session: 's-1' });

    // Act
    const decision = decideConversationLease(existing, claim({ pid: 11 }), alive(5));

    // Assert
    should(decision).equal('held');
  });
});

describe('conversationLeaseRefusal', () => {
  it('should name the holding session, its runtime and since when', () => {
    // Arrange
    const existing = lease({ pid: 10, session: 's-1', runtime: 'claude-review' });

    // Act
    const sentence = conversationLeaseRefusal(existing);

    // Assert
    should(sentence).equal(
      `conversation ${CONVERSATION} is being written by session s-1 on claude-review since 2026-10-13 14:02 UTC: stop or resume session s-1 instead; only one writer may hold a conversation at a time`,
    );
  });

  it('should print a holder session and runtime without any control, line-separator or bidi character a lease file can carry', () => {
    // Arrange — escape, C1, a line separator, bidi override/isolate/mark: each can redraw or reorder a terminal line
    const hostile = (name: string): string => `${name}\u001b[2K\u009b ‮⁦‎؜\u0007\u007f\r\n`;
    const existing = lease({ pid: 10, session: hostile('s-1'), runtime: hostile('claude-review') });

    // Act
    const sentence = conversationLeaseRefusal(existing);

    // Assert — only the visible text is left, in both places the session is named
    should(sentence).equal(
      `conversation ${CONVERSATION} is being written by session s-1[2K on claude-review[2K since 2026-10-13 14:02 UTC: stop or resume session s-1[2K instead; only one writer may hold a conversation at a time`,
    );
    should(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(sentence)).be.false();
  });

  it('should leave an ordinary session and runtime exactly as written, including non-latin text', () => {
    // Arrange
    const existing = lease({ pid: 10, session: 'sé-ß-日本', runtime: 'claude review' });

    // Act
    const sentence = conversationLeaseRefusal(existing);

    // Assert
    should(sentence).containEql('session sé-ß-日本 on claude review since');
  });

  it('should name a session with no runtime', () => {
    // Arrange
    const existing = lease({ pid: 10, session: 's-1' });

    // Act
    const sentence = conversationLeaseRefusal(existing);

    // Assert
    should(sentence).startWith(`conversation ${CONVERSATION} is being written by session s-1 since`);
  });

  it('should name the process when no session holds it, and never a path', () => {
    // Arrange
    const existing = lease({ pid: 4242 });

    // Act
    const error = new ConversationLeaseHeldError(existing);

    // Assert
    should(error.name).equal('ConversationLeaseHeldError');
    should(error.lease).equal(existing);
    should(error.message).equal(
      `conversation ${CONVERSATION} is being written by another claude running as process 4242 since 2026-10-13 14:02 UTC: close that one first; only one writer may hold a conversation at a time`,
    );
    should(error.message).not.containEql('/');
  });
});

describe('ConversationLeaseRecordSchema', () => {
  it('should refuse a conversation id that could name a path', () => {
    // Arrange
    const candidates = ['../x', 'a/b', '.hidden', ''];

    // Act
    const accepted = candidates.filter(
      conversation => ConversationLeaseRecordSchema.safeParse({ ...lease({ pid: 1 }), conversation }).success,
    );

    // Assert
    should(accepted).be.empty();
  });
});

describe('ConversationIdSchema', () => {
  it.each([
    ['empty', ''],
    ['the folder itself', '.'],
    ['its parent', '..'],
    ['a hidden name', '.lock'],
    ['a path', 'a/b'],
    ['a path out', '../escape'],
    ['an absolute path', '/etc/passwd'],
    ['a NUL', 'a\0b'],
    ['an option', '-rf'],
    ['an option spelled long', '--resume'],
    ['a leading underscore', '_x'],
    ['a dot inside', 'a.b'],
    ['a space', 'a b'],
    ['a backslash', 'a\\b'],
    ['a newline', 'a\nb'],
    ['a non-ASCII letter', 'é'],
    ['129 characters', `a${'b'.repeat(128)}`],
  ])('should refuse %s as a conversation id', (_why, candidate) => {
    // Act
    const parsed = ConversationIdSchema.safeParse(candidate);

    // Assert
    should(parsed.success).be.false();
  });

  it('should take a harness id, and a plain name up to 128 characters', () => {
    // Arrange
    const candidates = [CONVERSATION, 'api-token', 'A9_z-0', `a${'b'.repeat(127)}`];

    // Act
    const parsed = candidates.map(candidate => ConversationIdSchema.safeParse(candidate).data);

    // Assert
    should(parsed).eql(candidates);
  });
});

describe('conversationFromArguments', () => {
  it('should read the conversation each Claude flag spelling names', () => {
    // Arrange
    const launches = [
      ['--session-id', CONVERSATION],
      [`--session-id=${CONVERSATION}`],
      ['--model', 'x', '--resume', CONVERSATION],
      ['-r', CONVERSATION],
      [`--resume=${CONVERSATION}`],
      ['--resume', 'other', '--session-id', CONVERSATION],
    ];

    // Act
    const read = launches.map(args => conversationFromArguments('claude', args));

    // Assert
    should(read).eql(launches.map(() => CONVERSATION));
  });

  it('should name nothing for a Claude launch that picks its conversation later or forks it', () => {
    // Arrange
    const launches = [
      ['--continue'],
      ['--resume'],
      ['--resume', '--model', 'x'],
      ['--resume', CONVERSATION, '--fork-session'],
      ['--resume', '../escape'],
      [],
    ];

    // Act
    const read = launches.map(args => conversationFromArguments('claude', args));

    // Assert
    should(read).eql(launches.map(() => undefined));
  });

  it('should read the conversation a Codex resume names', () => {
    // Arrange
    const launches = [
      ['resume', CONVERSATION],
      ['exec', 'resume', CONVERSATION],
      ['-m', 'gpt', 'resume', '-c', 'x=y', CONVERSATION],
    ];

    // Act
    const read = launches.map(args => conversationFromArguments('codex', args));

    // Assert
    should(read).eql(launches.map(() => CONVERSATION));
  });

  it('should name nothing for a Codex launch that picks its conversation later', () => {
    // Arrange
    const launches = [['resume', '--last'], ['resume'], ['--no-alt-screen'], ['fork', CONVERSATION]];

    // Act
    const read = launches.map(args => conversationFromArguments('codex', args));

    // Assert
    should(read).eql(launches.map(() => undefined));
  });
});

/** A disk in memory: leases by harness and conversation, the processes that are running, and the order of its calls. */
class FakeDisk implements ConversationLeaseDisk {
  readonly files = new Map<string, string>();
  readonly running = new Map<number, number>();
  readonly calls: string[] = [];
  locks = 0;

  async exclusive<T>(harness: HistoryHarness, work: () => Promise<T>): Promise<T> {
    this.calls.push(`lock ${harness}`);
    this.locks += 1;
    try {
      return await work();
    } finally {
      this.locks -= 1;
      this.calls.push(`unlock ${harness}`);
    }
  }

  async read(harness: HistoryHarness, conversation: ConversationId): Promise<string | undefined> {
    this.calls.push(`read ${harness}/${conversation} locked=${String(this.locks)}`);
    return this.files.get(`${harness}/${conversation}`);
  }

  async write(harness: HistoryHarness, conversation: ConversationId, text: string): Promise<void> {
    this.calls.push(`write ${harness}/${conversation} locked=${String(this.locks)}`);
    this.files.set(`${harness}/${conversation}`, text);
  }

  async remove(harness: HistoryHarness, conversation: ConversationId): Promise<void> {
    this.calls.push(`remove ${harness}/${conversation} locked=${String(this.locks)}`);
    this.files.delete(`${harness}/${conversation}`);
  }

  async list(harness: HistoryHarness): Promise<readonly string[]> {
    return [...this.files.keys()]
      .filter(key => key.startsWith(`${harness}/`))
      .map(key => key.slice(harness.length + 1));
  }

  async startOf(pid: number): Promise<number | undefined> {
    return this.running.get(pid);
  }
}

const NOW = new Date('2026-11-15T10:00:00.000Z');
const unknown = async (): Promise<ConversationHolderStanding> => 'unknown';

function stored(disk: FakeDisk, conversation = CONVERSATION): ConversationLeaseRecord {
  return JSON.parse(disk.files.get(`claude/${conversation}`) as string) as ConversationLeaseRecord;
}

describe('ConversationLeaseStore', () => {
  it('should create a lease for a free conversation, recording the claimant start read by the store itself', async () => {
    // Arrange
    const disk = new FakeDisk();
    disk.running.set(10, 77);
    const store = new ConversationLeaseStore(disk, () => NOW);

    // Act
    const outcome = await store.claim(claim({ pid: 10, runtime: 'claude-default' }), unknown);

    // Assert
    should(outcome.kind).equal('claimed');
    should(stored(disk)).eql({
      v: 1,
      harness: 'claude',
      conversation: CONVERSATION,
      holder: { pid: 10, start: 77, runtime: 'claude-default' },
      since: '2026-11-15T10:00:00.000Z',
    });
  });

  it('should decide and write only while holding the pool lock', async () => {
    // Arrange
    const disk = new FakeDisk();
    const store = new ConversationLeaseStore(disk, () => NOW);

    // Act
    await store.claim(claim({ pid: 10 }), unknown);

    // Assert
    should(disk.calls).eql([
      'lock claude',
      `read claude/${CONVERSATION} locked=1`,
      `write claude/${CONVERSATION} locked=1`,
      'unlock claude',
    ]);
  });

  it('should leave a lease with no start when the host cannot report one', async () => {
    // Arrange
    const disk = new FakeDisk();
    const store = new ConversationLeaseStore(disk, () => NOW);

    // Act
    await store.claim(claim({ pid: 10 }), unknown);

    // Assert
    should(stored(disk).holder).eql({ pid: 10 });
  });

  it('should report the live holder and write nothing when another writer holds the conversation', async () => {
    // Arrange
    const disk = new FakeDisk();
    disk.running.set(10, 5);
    disk.files.set(`claude/${CONVERSATION}`, JSON.stringify(lease({ pid: 10, start: 5 })));
    const store = new ConversationLeaseStore(disk, () => NOW);

    // Act
    const outcome = await store.claim(claim({ pid: 11 }), unknown);

    // Assert
    should(outcome).eql({ kind: 'held', lease: lease({ pid: 10, start: 5 }) });
    should(disk.calls.filter(call => call.startsWith('write'))).be.empty();
  });

  it('should keep the original since when the same session renews its lease', async () => {
    // Arrange
    const disk = new FakeDisk();
    disk.files.set(`claude/${CONVERSATION}`, JSON.stringify(lease({ pid: 10, session: 's-1' })));
    const store = new ConversationLeaseStore(disk, () => NOW);

    // Act
    const outcome = await store.claim(claim({ pid: 55, session: 's-1' }), unknown);

    // Assert
    should(outcome.kind === 'claimed' && outcome.decision).equal('renew');
    should(stored(disk).since).equal('2026-10-13T14:02:09.000Z');
    should(stored(disk).holder.pid).equal(55);
  });

  it('should take over a lease whose holder is gone and say it is a new writer since now', async () => {
    // Arrange
    const disk = new FakeDisk();
    disk.files.set(`claude/${CONVERSATION}`, JSON.stringify(lease({ pid: 10, start: 5 })));
    const store = new ConversationLeaseStore(disk, () => NOW);

    // Act
    const outcome = await store.claim(claim({ pid: 11 }), unknown);

    // Assert
    should(outcome.kind === 'claimed' && outcome.decision).equal('take-over');
    should(stored(disk).since).equal('2026-11-15T10:00:00.000Z');
  });

  it('should ask whether the holding session is still writing, and let that answer decide', async () => {
    // Arrange
    const disk = new FakeDisk();
    disk.files.set(`claude/${CONVERSATION}`, JSON.stringify(lease({ pid: 10, start: 5, session: 's-1' })));
    const store = new ConversationLeaseStore(disk, () => NOW);
    const asked: string[] = [];

    // Act
    const outcome = await store.claim(claim({ pid: 11, session: 's-2' }), async session => {
      asked.push(session);
      return 'live';
    });

    // Assert
    should(asked).eql(['s-1']);
    should(outcome.kind).equal('held');
  });

  it('should create over a file that is not a lease for this conversation', async () => {
    // Arrange
    const disk = new FakeDisk();
    const store = new ConversationLeaseStore(disk, () => NOW);
    const impostors = ['not json', '{"v":2}', JSON.stringify(lease({ pid: 10, start: 5 }, OTHER))];

    // Act
    const outcomes = [];
    for (const text of impostors) {
      disk.files.set(`claude/${CONVERSATION}`, text);
      outcomes.push(await store.claim(claim({ pid: 11 }), unknown));
    }

    // Assert
    should(outcomes.map(outcome => outcome.kind === 'claimed' && outcome.decision)).eql(['create', 'create', 'create']);
  });

  it('should refuse a conversation id that is not one before touching the disk', async () => {
    // Arrange
    const disk = new FakeDisk();
    const store = new ConversationLeaseStore(disk, () => NOW);
    const escaping = {
      harness: 'claude',
      conversation: '../escape',
      holder: { pid: 1 },
    } as unknown as ConversationLeaseClaim;

    // Act
    const claiming = store.claim(escaping, unknown);

    // Assert
    await should(claiming).be.rejected();
    should(disk.calls).be.empty();
  });

  it('should release every lease one session holds in every pool, and no one else', async () => {
    // Arrange
    const disk = new FakeDisk();
    disk.files.set(`claude/${CONVERSATION}`, JSON.stringify(lease({ pid: 10, session: 's-1' })));
    disk.files.set(`claude/${OTHER}`, JSON.stringify(lease({ pid: 10, session: 's-2' }, OTHER)));
    disk.files.set(
      `codex/${CONVERSATION}`,
      JSON.stringify({ ...lease({ pid: 10, session: 's-1' }), harness: 'codex' }),
    );
    disk.files.set('claude/not-a-lease', 'garbage');
    disk.files.set('claude/.hidden', '{}');
    const store = new ConversationLeaseStore(disk, () => NOW);

    // Act
    const released = await store.releaseSession('s-1');

    // Assert
    should(released).eql([CONVERSATION, CONVERSATION]);
    should([...disk.files.keys()].sort()).eql(['claude/.hidden', `claude/${OTHER}`, 'claude/not-a-lease']);
    should(disk.calls.filter(call => call.startsWith('remove')).every(call => call.endsWith('locked=1'))).be.true();
  });

  it('should bound what a disk may be asked to read to a few kilobytes', () => {
    // Assert
    should(MAX_LEASE_BYTES).equal(64 * 1024);
  });
});
