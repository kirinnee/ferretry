import { describe, it } from 'bun:test';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import should from 'should';
import {
  type ConversationHolderStanding,
  ConversationIdSchema,
  type ConversationLeaseClaim,
  type ConversationLeaseOutcome,
  type ConversationLeaseRecord,
  HISTORY_CLAIM_HELD_EXIT_CODE,
} from '../../../../contract/conversation-lease.ts';
import { HistoryController, type IHistoryIo } from '../../../../cli/lib/history/controller.ts';
import { historyClaimRequest } from '../../../../cli/lib/history/request.ts';
import { SessionCommandError } from '../../../../cli/lib/session/errors.ts';

const CONVERSATION = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');

const HELD: ConversationLeaseRecord = {
  v: 1,
  harness: 'claude',
  conversation: CONVERSATION,
  holder: { pid: 7, session: 'ms8-holder01', runtime: 'claude-review' },
  since: '2026-10-13T14:02:00.000Z',
};

class FakeStore {
  readonly claims: ConversationLeaseClaim[] = [];
  readonly standings: ConversationHolderStanding[] = [];
  held = false;

  async claim(
    claim: ConversationLeaseClaim,
    standing: (session: string) => Promise<ConversationHolderStanding>,
  ): Promise<ConversationLeaseOutcome> {
    this.claims.push(claim);
    this.standings.push(await standing('ms8-holder01'));
    return this.held ? { kind: 'held', lease: HELD } : { kind: 'claimed', decision: 'create', lease: HELD };
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
    // Only the daemon holds session records, so a terminal claim can never judge a holder by its session.
    should(store.standings).eql(['unknown']);
    should(io.errors).be.empty();
    should(io.code).be.undefined();
  });

  it('should say who holds the conversation and fail with the held status when another writer has it', async () => {
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
    should(io.code).equal(HISTORY_CLAIM_HELD_EXIT_CODE);
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

  it('should refuse a named conversation id that could be a path before any claim is made', async () => {
    // Arrange
    const store = new FakeStore();
    const controller = new HistoryController(store, new RecordingIo(), {});

    // Act
    const claiming = controller.claim({ harness: 'claude', pid: 42, conversation: '../escape' });

    // Assert
    await should(claiming).be.rejectedWith('not a conversation id: "../escape"');
    should(store.claims).be.empty();
  });
});

const invocation = (args: readonly string[], options: VerbInvocation['options']): VerbInvocation => ({ args, options });

describe('historyClaimRequest', () => {
  it('should read the exact words a wrapper sends: the harness, $$ and every launch argument after the dashes', () => {
    // Act
    const request = historyClaimRequest(
      invocation(['--resume', CONVERSATION, '--model', 'x'], {
        harness: 'claude',
        pid: '4242',
        'from-arguments': true,
      }),
    );

    // Assert
    should(request).eql({ harness: 'claude', pid: 4242, arguments: ['--resume', CONVERSATION, '--model', 'x'] });
  });

  it('should read a conversation a person names as the first word', () => {
    // Act
    const request = historyClaimRequest(invocation([CONVERSATION], { harness: 'codex', pid: '9' }));

    // Assert
    should(request).eql({ harness: 'codex', pid: 9, conversation: CONVERSATION });
  });

  it('should name no conversation when no word follows', () => {
    // Act
    const request = historyClaimRequest(invocation([], { harness: 'codex', pid: '9' }));

    // Assert
    should(request).eql({ harness: 'codex', pid: 9 });
  });

  it.each([
    ['no harness', {}, /--harness is required/u],
    ['an unknown harness', { harness: 'gemini', pid: '9' }, /--harness is required/u],
    ['no pid', { harness: 'claude' }, /--pid is required/u],
    ['a pid that is a word', { harness: 'claude', pid: 'me' }, /--pid is required/u],
    ['a zero pid', { harness: 'claude', pid: '0' }, /--pid is required/u],
    ['a negative pid', { harness: 'claude', pid: '-3' }, /--pid is required/u],
    ['a fractional pid', { harness: 'claude', pid: '1.5' }, /--pid is required/u],
  ])('should refuse %s as a caller mistake, never as the held status', (_why, options, message) => {
    // Act
    const reading = (): unknown => historyClaimRequest(invocation([], options));

    // Assert
    should(reading).throw(SessionCommandError, { message });
  });
});
