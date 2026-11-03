import { describe, it } from 'bun:test';
import { BoardQuerySchema, type BoardTaskActionRequest, BoardTaskCreateRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { SessionOwnerWords, type TurnFiles } from '../../../src/adapters/board/session-owner-words.ts';
import { BoardError, BoardService, BoardUnavailableError } from '../../../src/lib/board/index.ts';
import { card, MemoryBoardStore, PROJECT, world } from './support.ts';

const SESSION = 'lead';
const OWNER_SAID = 'Build a board that shows only the work the owner asked for';
const ask = { text: OWNER_SAID, source: `session:${SESSION}` };
const lead = { kind: 'ferret', sessionId: SESSION } as const;
const failures = [
  'queue',
  'ledger',
  'lineage',
  'directory-stat',
  'directory-list',
  'turn-stat',
  'turn-read',
  'author',
] as const;
type Failure = (typeof failures)[number];

/** The production adapter over failing ports; recovery changes no timestamps, just restores readability. */
const fixture = (failure: Failure) => {
  let broken = true;
  const fail = (at: Failure) => {
    if (broken && failure === at) throw new Error(`${at} unreadable`);
  };
  const files: TurnFiles = {
    modified: async path => {
      fail(path.endsWith('/turns') ? 'directory-stat' : 'turn-stat');
      return 1;
    },
    list: async () => {
      fail('directory-list');
      return ['turn-002.md', 'turn-002.by.json'];
    },
    read: async path => {
      fail(path.endsWith('.md') ? 'turn-read' : 'author');
      return path.endsWith('.md') ? OWNER_SAID : '{"kind":"owner"}';
    },
  };
  const words = new SessionOwnerWords(
    {
      list: async () => {
        fail('queue');
        return [];
      },
    },
    {
      list: async () => {
        fail('ledger');
        return [];
      },
    },
    {
      parentOf: async () => {
        fail('lineage');
        return undefined;
      },
    },
    id => `/sessions/${id}/turns`,
    files,
  );
  return {
    words,
    recover: () => {
      broken = false;
    },
  };
};

const operations = ['create', 'edit', 'visibility'] as const;
const request = (visibility?: 'private') =>
  BoardTaskCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Owner board',
    ask,
    projectId: PROJECT,
    assignee: SESSION,
    ...(visibility === undefined ? {} : { visibility }),
  });
const change: Record<'edit' | 'visibility', BoardTaskActionRequest> = {
  edit: { action: 'edit', title: 'Must not be written', visibility: 'private' },
  visibility: { action: 'visibility', visibility: 'private' },
};

describe('strict private choices through SessionOwnerWords', () => {
  for (const failure of failures) {
    for (const operation of operations) {
      it(`should write nothing for ${operation} with unreadable ${failure}, then publish the recovered owner ask`, async () => {
        // Arrange: an earlier best-effort read stored an agent guess.
        const { words, recover } = fixture(failure);
        const guessed = card({ ask, askedBy: 'agent', visibility: 'private', visibilitySource: 'default' });
        const ports = world({ store: new MemoryBoardStore([guessed]), ownerWords: words });
        const subject = new BoardService(ports);
        const task = guessed;
        const store = ports.store as MemoryBoardStore;
        const before = store.cards.get(task.id);
        const writes = store.writes.length;
        await words.said(SESSION);
        const hide = () =>
          operation === 'create'
            ? subject.create(request('private'), lead)
            : subject.act(task.id, change[operation], lead);

        // Act + Assert: incomplete words cannot authorize any explicit private choice.
        await hide().then(
          () => should.fail(undefined, undefined, 'an incomplete read authorized private'),
          (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
        );
        should(store.writes.length).equal(writes);
        should([...store.cards.values()]).eql([before]);

        recover();
        await hide().then(
          () => should.fail(undefined, undefined, 'a ferret hid a recovered owner ask'),
          (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
        );
        await subject.backfillAskedBy();
        await subject.backfillVisibility();
        should(store.cards.get(task.id)).match({
          askedBy: 'person',
          visibility: 'public',
          visibilitySource: 'default',
        });
        should(
          (await subject.board(BoardQuerySchema.parse({ visibility: 'public' }))).cards.map(value => value.id),
        ).eql([task.id]);
      });
    }

    it(`should preserve owner overrides and lenient backfills with unreadable ${failure}`, async () => {
      // Arrange
      const { words, recover } = fixture(failure);
      const before = card({ ask, askedBy: 'agent', visibility: 'private', visibilitySource: 'default' });
      const ports = world({ store: new MemoryBoardStore([before]), ownerWords: words });
      const subject = new BoardService(ports);

      // Act + Assert
      await subject.create(request(), lead);
      await subject.backfillAskedBy();
      await subject.backfillVisibility();
      await subject.act(before.id, { action: 'visibility', visibility: 'private' }, { kind: 'owner' });
      const { task } = await subject.create(request('private'), { kind: 'owner', via: 'admin-token' });
      recover();
      await subject.backfillAskedBy();
      await subject.backfillVisibility();
      for (const id of [before.id, task.id]) {
        should(ports.store.cards.get(id)).match({
          askedBy: 'person',
          visibility: 'private',
          visibilitySource: 'chosen',
        });
      }
    });
  }

  it('should refuse an explicit private choice when the OwnerWords port is absent', async () => {
    // Arrange
    const ports = world();
    const subject = new BoardService(ports);

    // Act + Assert
    await subject.create(request('private'), lead).then(
      () => should.fail(undefined, undefined, 'missing owner words authorized private'),
      (error: unknown) => should(error).be.instanceOf(BoardUnavailableError),
    );
    should(ports.store.cards.size).equal(0);
  });
});
