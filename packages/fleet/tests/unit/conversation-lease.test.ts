import { describe, it } from 'bun:test';
import should from 'should';
import {
  ConversationIdSchema,
  type ConversationLeaseClaim,
  type ConversationLeaseFacts,
  ConversationLeaseHeldError,
  type ConversationLeaseRecord,
  ConversationLeaseRecordSchema,
  conversationFromArguments,
  conversationLeaseDirectory,
  conversationLeaseRefusal,
  decideConversationLease,
  sharedHistoryPoolDirectory,
  sharedHistoryPoolRequests,
  sharedHistoryPoolRoot,
} from '../../src/lib/shared-history.ts';

const CONVERSATION = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');

function lease(holder: ConversationLeaseRecord['holder']): ConversationLeaseRecord {
  return { v: 1, harness: 'claude', conversation: CONVERSATION, holder, since: '2026-10-13T14:02:09.000Z' };
}

function claim(holder: ConversationLeaseClaim['holder']): ConversationLeaseClaim {
  return { harness: 'claude', conversation: CONVERSATION, holder };
}

const alive = (start: number): ConversationLeaseFacts => ({ holderStart: start, holderSession: 'unknown' });

describe('shared history pool paths', () => {
  it('should put each harness pool and its leases under fleet/shared', () => {
    // Arrange
    const fleet = '/state/fleet';

    // Act
    const paths = [
      sharedHistoryPoolRoot(fleet),
      sharedHistoryPoolDirectory(fleet, 'claude'),
      conversationLeaseDirectory(fleet, 'codex'),
    ];

    // Assert
    should(paths).eql(['/state/fleet/shared', '/state/fleet/shared/claude', '/state/fleet/shared/codex/.leases']);
  });

  it('should plan a pool for every harness with no switch to read', () => {
    // Arrange
    const homes = { claude: [{ account: 'a', path: '/state/fleet/homes/a' }], codex: [] };

    // Act
    const requests = sharedHistoryPoolRequests('/state/fleet', homes);

    // Assert
    should(requests).eql([
      { kind: 'claude', poolRoot: '/state/fleet/shared', homes: [{ account: 'a', path: '/state/fleet/homes/a' }] },
      { kind: 'codex', poolRoot: '/state/fleet/shared', homes: [] },
    ]);
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

  it('should name a session with no runtime', () => {
    // Arrange
    const existing = lease({ pid: 10, session: 's-1' });

    // Act
    const sentence = conversationLeaseRefusal(existing);

    // Assert
    should(sentence).startWith(`conversation ${CONVERSATION} is being written by session s-1 since`);
  });

  it('should name the process when no session holds it', () => {
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
