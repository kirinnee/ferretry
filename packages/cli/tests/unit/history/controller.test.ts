import { describe, it } from 'bun:test';
import {
  type ConversationHolderStanding,
  ConversationIdSchema,
  type ConversationLeaseClaim,
  type ConversationLeaseRecord,
  type ConversationLeaseStore,
} from '@ferretry/fleet';
import should from 'should';
import { HistoryController, type IHistoryIo } from '../../../src/lib/history/controller.ts';

const CONVERSATION = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');

const HELD: ConversationLeaseRecord = {
  v: 1,
  harness: 'claude',
  conversation: CONVERSATION,
  holder: { pid: 7, session: 'ms8-holder01', runtime: 'claude-review' },
  since: '2026-10-13T14:02:00.000Z',
};

class FakeStore implements ConversationLeaseStore {
  readonly claims: ConversationLeaseClaim[] = [];
  readonly standings: ConversationHolderStanding[] = [];
  held = false;

  async claim(
    claim: ConversationLeaseClaim,
    standing: (session: string) => Promise<ConversationHolderStanding>,
  ): ReturnType<ConversationLeaseStore['claim']> {
    this.claims.push(claim);
    this.standings.push(await standing('ms8-holder01'));
    return this.held ? { kind: 'held', lease: HELD } : { kind: 'claimed', decision: 'create', lease: HELD };
  }

  async releaseSession(): Promise<readonly string[]> {
    return [];
  }
}

class RecordingIo implements IHistoryIo {
  readonly errors: string[] = [];
  code: number | undefined;
  error(message: string): void {
    this.errors.push(message);
  }
  setExitCode(code: number): void {
    this.code = code;
  }
}

describe('HistoryController', () => {
  it('should claim silently for the pid, carrying the daemon session and runtime it was launched under', async () => {
    // Arrange
    const store = new FakeStore();
    const io = new RecordingIo();
    const controller = new HistoryController(store, io, { session: 'ms8-abcd1234', runtime: 'claude-default' });

    // Act
    await controller.claim({ harness: 'claude', pid: 42, arguments: ['--resume', CONVERSATION] });

    // Assert
    should(store.claims).eql([
      {
        harness: 'claude',
        conversation: CONVERSATION,
        holder: { pid: 42, session: 'ms8-abcd1234', runtime: 'claude-default' },
      },
    ]);
    should(store.standings).eql(['unknown']);
    should(io.errors).be.empty();
    should(io.code).be.undefined();
  });

  it('should say who holds the conversation and fail when another writer has it', async () => {
    // Arrange
    const store = new FakeStore();
    store.held = true;
    const io = new RecordingIo();
    const controller = new HistoryController(store, io, {});

    // Act
    await controller.claim({ harness: 'claude', pid: 42, conversation: CONVERSATION });

    // Assert
    should(store.claims[0]?.holder).eql({ pid: 42 });
    should(io.errors).eql([
      `conversation ${CONVERSATION} is being written by session ms8-holder01 on claude-review since 2026-10-13 14:02 UTC: stop or resume session ms8-holder01 instead; only one writer may hold a conversation at a time`,
    ]);
    // The one status a wrapper treats as "do not launch"; every other failure launches anyway.
    should(io.code).equal(75);
  });

  it('should claim nothing when the launch names no conversation', async () => {
    // Arrange
    const store = new FakeStore();
    const controller = new HistoryController(store, new RecordingIo(), {});

    // Act
    await controller.claim({ harness: 'codex', pid: 42, arguments: ['resume', '--last'] });
    await controller.claim({ harness: 'codex', pid: 42 });

    // Assert
    should(store.claims).be.empty();
  });

  it('should refuse a named conversation id that could be a path', async () => {
    // Arrange
    const controller = new HistoryController(new FakeStore(), new RecordingIo(), {});

    // Act
    const claiming = controller.claim({ harness: 'claude', pid: 42, conversation: '../escape' });

    // Assert
    await should(claiming).be.rejectedWith('not a conversation id: "../escape"');
  });
});
