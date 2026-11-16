/**
 * The ferret's board is a conditional read for its owner: the app polls it, and a board nobody touched costs a stat, not a
 * read, a serialisation and an encryption. Its tag is the board's stamp (a stat of the ledger) plus the little the outbox
 * adds, so the tag moves when the board moves and when the held answers move, and stands still when nothing did.
 */
import { describe, expect, it } from 'bun:test';
import type { ApiResponse } from '@ferretry/kernel/contract';
import {
  type AgendaLedger,
  type AgendaMutation,
  type AgendaRepliesSubsystem,
  AgendaService,
} from '../../../../daemon/lib/agenda/index.ts';
import { AGENDA_CHANNEL_HEADER, AGENDA_CHANNEL_VERSION } from '../../../../daemon/lib/protocol/agenda.ts';
import { agendaRoutes } from '../../../../daemon/lib/routes/agenda.ts';
import {
  agentIn,
  FakeLedgerRepository,
  human,
  NO_HELD_REPLIES,
  type RequestOverrides,
  routeDispatcher,
} from './support.ts';

const AT = '2024-05-01T10:00:00.000Z';
const PATH = '/v1/ferrets/s1/agenda';

/** A fake ledger whose stamp moves with every committed change, as a file's identity does. */
class StampedLedger extends FakeLedgerRepository {
  revision = 0;
  stamps = 0;
  reads = 0;

  override async read(): Promise<AgendaLedger | null> {
    this.reads += 1;
    return await super.read();
  }

  async stamp(): Promise<string> {
    this.stamps += 1;
    return `rev-${String(this.revision)}`;
  }

  override async transact(
    sessionId: string,
    apply: (current: AgendaLedger | null) => AgendaMutation,
  ): Promise<AgendaMutation> {
    const mutation = await super.transact(sessionId, apply);
    if (mutation.ok) this.revision += 1;
    return mutation;
  }
}

const fixture = (replies: AgendaRepliesSubsystem = NO_HELD_REPLIES, repository = new StampedLedger()) => {
  const service = new AgendaService(
    repository,
    { now: () => AT },
    { has: async id => id === 's1' },
    { raised: async () => undefined },
  );
  const dispatch = routeDispatcher(agendaRoutes(service, replies, { enrolledDevices: async () => 0 }));
  return {
    repository,
    service,
    read: (headers: RequestOverrides['headers'] = human, path = PATH, build?: string): Promise<ApiResponse> =>
      dispatch({ path, headers, ...(build === undefined ? {} : { build }) }),
    /** A ferret raising an ask on its own board: the board's ledger changes. */
    raise: (): Promise<ApiResponse> =>
      dispatch({ method: 'POST', path: PATH, headers: agentIn('s1'), body: JSON.stringify(RAISE) }),
  };
};

const RAISE = {
  action: 'add',
  title: 'Release unblock',
  subject: 'which base branch?',
  why: 'the ticket names two',
  premise: 'A ferret needs the owner.',
  context: 'The work waits on this answer.',
  howToResolve: 'name the branch to target',
  ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
};

const tagOf = (response: ApiResponse): string => {
  const tag = response.headers.get('etag');
  if (tag === undefined) throw new Error('the answer carries no etag');
  return tag;
};

describe('GET /v1/ferrets/:ferretId/agenda is a conditional read for its owner', () => {
  it('answers 200 with an etag, then 304 with no body and no read of the board for a repeat that names it', async () => {
    const { read, repository } = fixture();
    const first = await read();
    expect(first.status).toBe(200);
    const tag = tagOf(first);
    const readsBefore = repository.reads;

    const again = await read({ ...human, 'if-none-match': tag });

    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.get('etag')).toBe(tag);
    // The board was not read for the 304: the stamp alone answered it.
    expect(repository.reads).toBe(readsBefore);
  });

  it('answers 200 with a NEW etag once the board has changed', async () => {
    const { read, raise, repository } = fixture();
    const tag = tagOf(await read());

    expect((await raise()).status).toBe(200);
    const changed = await read({ ...human, 'if-none-match': tag });

    expect(repository.revision).toBe(1);
    expect(changed.status).toBe(200);
    expect(tagOf(changed)).not.toBe(tag);
    expect(JSON.parse(changed.body).items).toHaveLength(1);
    // And that new tag is the one a repeat is answered 304 for.
    expect((await read({ ...human, 'if-none-match': tagOf(changed) })).status).toBe(304);
  });

  it('names the daemon build: the same board under another build is a 200, under the same build a 304', async () => {
    const { read } = fixture();
    const held = tagOf(await read({ ...human }, PATH, '5.0.0+aaa'));
    expect((await read({ ...human, 'if-none-match': held }, PATH, '5.0.0+aaa')).status).toBe(304);
    const upgraded = await read({ ...human, 'if-none-match': held }, PATH, '5.0.0+bbb');
    expect(upgraded.status).toBe(200);
    expect(upgraded.body).not.toBe('');
    expect(tagOf(upgraded)).not.toBe(held);
  });

  it('names the projection: channel 2 and the plain read are different bodies, so different tags', async () => {
    const { read } = fixture();
    const plain = tagOf(await read());
    const channel = tagOf(await read({ ...human, [AGENDA_CHANNEL_HEADER]: AGENDA_CHANNEL_VERSION }));
    expect(channel).not.toBe(plain);
    // The plain tag does not answer a channel-2 read.
    const crossed = await read({ ...human, [AGENDA_CHANNEL_HEADER]: AGENDA_CHANNEL_VERSION, 'if-none-match': plain });
    expect(crossed.status).toBe(200);
  });

  it('moves the tag when the held answers move, though the ledger did not', async () => {
    let dueAt: string | undefined;
    const replies: AgendaRepliesSubsystem = {
      pending: async () =>
        dueAt === undefined ? undefined : ({ pending: [{ id: 'A1' }], dueAt } as unknown as ReturnType<never>),
      delivery: async () => undefined,
      sendNow: async () => undefined,
    };
    const { read, repository } = fixture(replies);
    const tag = tagOf(await read());
    dueAt = '2024-05-01T10:01:00.000Z';

    const moved = await read({ ...human, 'if-none-match': tag });

    expect(moved.status).toBe(200);
    expect(tagOf(moved)).not.toBe(tag);
    expect(repository.revision).toBe(0);
  });

  it('survives an outbox that cannot be read: the board is the answer, and it is still conditional', async () => {
    const broken: AgendaRepliesSubsystem = {
      pending: async () => Promise.reject(new Error('unreadable')),
      delivery: async () => Promise.reject(new Error('unreadable')),
      sendNow: async () => undefined,
    };
    const { read } = fixture(broken);
    const first = await read();
    expect(first.status).toBe(200);
    expect((await read({ ...human, 'if-none-match': tagOf(first) })).status).toBe(304);
  });

  it('still refuses an unknown session before it can say 304', async () => {
    const { read } = fixture();
    const unknown = await read({ ...human, 'if-none-match': '*' }, '/v1/ferrets/nobody/agenda');
    expect(unknown.status).toBe(404);
  });

  it('is not conditional for a ferret: its board is cut by whose items it may read, which no ledger stamp names', async () => {
    const { read, repository } = fixture();
    const own = await read(agentIn('s1'));
    expect(own.status).toBe(200);
    expect(own.headers.has('etag')).toBe(false);
    const again = await read({ ...agentIn('s1'), 'if-none-match': '*' });
    expect(again.status).toBe(200);
    expect(repository.stamps).toBe(0);
  });

  it('still refuses an unknown session to a ferret, which is read whole', async () => {
    const { read } = fixture();
    const unknown = await read(agentIn('nobody'), '/v1/ferrets/nobody/agenda');
    expect(unknown.status).toBe(404);
  });

  it('reads the board whole, with no etag, from a store that cannot stamp', async () => {
    const service = new AgendaService(
      new FakeLedgerRepository(),
      { now: () => AT },
      { has: async id => id === 's1' },
      { raised: async () => undefined },
    );
    const dispatch = routeDispatcher(agendaRoutes(service, NO_HELD_REPLIES, { enrolledDevices: async () => 0 }));
    const answered = await dispatch({ path: PATH, headers: { ...human, 'if-none-match': '*' } });
    expect(answered.status).toBe(200);
    expect(answered.headers.has('etag')).toBe(false);
  });
});
