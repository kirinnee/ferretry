import { describe, it } from 'bun:test';
import type { AgendaId } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../src/lib/agenda/index.ts';
import { parseAgendaLedger } from '../../../src/lib/agenda/state-machine.ts';
import {
  InputAgendaAdapter,
  InputAgentNotifierAdapter,
  InputCardClosedObserver,
} from '../../../src/lib/input-requests/agenda-adapter.ts';
import type { InputCard } from '../../../src/lib/input-requests/ports.ts';

const SESSION = 'session-1';
const NOW = '2026-10-30T10:00:00Z';
const REQUEST = 'a'.repeat(32);
const HUMAN = { kind: 'human' as const };
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const card = (overrides: Partial<InputCard> = {}): InputCard => ({
  requestId: REQUEST,
  title: 'Needs a secret for %terminal:dev',
  ask: 'A ferret asked for a value to type into %terminal:dev.',
  prompt: 'sudo password for deploy',
  blocking: false,
  expiresAt: '2026-10-30T10:15:00Z',
  ...overrides,
});

function world() {
  const repository = new MemoryRepository();
  const closed: { sessionId: string; id: AgendaId }[] = [];
  const observer = new InputCardClosedObserver(async (sessionId, id) => {
    closed.push({ sessionId, id });
  });
  const service = new AgendaService(
    repository,
    { now: () => NOW },
    { has: async sessionId => sessionId === SESSION },
    { raised: async () => undefined },
    observer,
  );
  return { repository, closed, service, adapter: new InputAgendaAdapter(service) };
}

const raisedId = async (adapter: InputAgendaAdapter, input: InputCard = card()): Promise<AgendaId> => {
  const result = await adapter.raise(SESSION, input);
  if (!result.ok) throw new Error(result.message);
  return result.id;
};

describe('InputAgendaAdapter', () => {
  it('should raise an ask-less input card the daemon worded, with the prompt under "The agent says"', async () => {
    // Arrange
    const { adapter, service } = world();

    // Act
    const id = await raisedId(adapter);
    const listed = await service.list(SESSION);

    // Assert
    const item = listed.ok ? listed.value.items.find(candidate => candidate.id === id) : undefined;
    should(item).match({
      kind: 'input',
      title: 'Needs a secret for %terminal:dev',
      subject: 'A ferret asked for a value to type into %terminal:dev.',
      why: 'A ferret asked for a value to type into %terminal:dev.',
      context: 'The agent says: sudo password for deploy',
      input: { requestId: REQUEST },
    });
    should(item).not.have.property('ask');
    should(item?.blockingNow).not.equal(true);
  });

  it('should keep the subject on one line when the ask carries a line break', async () => {
    const { adapter, service } = world();

    const id = await raisedId(adapter, card({ ask: 'Type it into\nsudo\u2028now' }));
    const listed = await service.list(SESSION);

    const item = listed.ok ? listed.value.items.find(candidate => candidate.id === id) : undefined;
    should(item?.subject).equal('Type it into sudo now');
  });

  it('should mark a blocking request blocking, and say which login it follows', async () => {
    // Arrange
    const { adapter, service } = world();

    // Act
    const id = await raisedId(adapter, card({ blocking: true, chain: 'A3' }));
    const listed = await service.list(SESSION);

    // Assert
    const item = listed.ok ? listed.value.items.find(candidate => candidate.id === id) : undefined;
    should(item?.blockingNow).equal(true);
    should(item?.context).equal('This follows A3 in the same login.\nThe agent says: sudo password for deploy');
  });

  it('should say why when the agenda refuses the card', async () => {
    // Arrange
    const { adapter } = world();

    // Act
    const refused = await new InputAgendaAdapter(
      new AgendaService(
        new MemoryRepository(),
        { now: () => NOW },
        { has: async () => false },
        { raised: async () => undefined },
      ),
    ).raise(SESSION, card());
    const kept = await adapter.raise(SESSION, card());

    // Assert
    should(refused.ok).be.false();
    should(kept.ok).be.true();
  });

  it('should report a raise that kept no card, and never throw closing a card the agenda lost', async () => {
    // Arrange
    const empty = new InputAgendaAdapter({
      raise: async () => ({ ok: true, changed: false }) as unknown as AgendaMutation,
      resolve: async () => {
        throw new Error('the agenda is gone');
      },
      list: async () => ({ ok: false, error: { code: 'not_found', message: 'no such session' } }) as never,
    });

    // Act
    const raised = await empty.raise(SESSION, card());
    const closing = empty.close(SESSION, 'A1', 'ended');
    const prompt = await empty.promptOf(SESSION, 'A1');

    // Assert
    should(raised).deepEqual({ ok: false, message: 'the agenda kept no card for this request' });
    await should(closing).be.fulfilled();
    should(prompt).be.undefined();
  });

  it('should close the card as the daemon’s own act, leaving the observer unheard', async () => {
    // Arrange
    const { adapter, service, closed } = world();
    const id = await raisedId(adapter);

    // Act
    await adapter.close(SESSION, id, 'The request ended.');
    const listed = await service.list(SESSION);

    // Assert
    should(listed.ok && listed.value.items.some(item => item.id === id)).be.false();
    should(closed).have.length(0);
  });

  it('should hand back the stored prompt, however many lines, and nothing for a card without one', async () => {
    // Arrange
    const { adapter, service } = world();
    const plain = await raisedId(adapter, card({ prompt: 'line one\nline two' }));
    const chained = await raisedId(adapter, card({ requestId: 'b'.repeat(32), prompt: 'otp', chain: plain }));
    const foreign = await service.raise(
      SESSION,
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Approve?',
        why: 'Needed.',
        howToResolve: 'Approve it.',
        ask: { kind: 'permission' },
        context: 'no marker here',
      },
      AGENT,
    );
    const bare = await service.raise(
      SESSION,
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Approve again?',
        why: 'Needed.',
        howToResolve: 'Approve it.',
        ask: { kind: 'permission' },
      },
      AGENT,
    );

    // Act
    const multi = await adapter.promptOf(SESSION, plain);
    const after = await adapter.promptOf(SESSION, chained);
    const missing = await adapter.promptOf(SESSION, 'A99');
    const noMarker = await adapter.promptOf(SESSION, foreign.ok && foreign.item ? foreign.item.id : 'A98');
    const noContext = await adapter.promptOf(SESSION, bare.ok && bare.item ? bare.item.id : 'A97');
    const otherSession = await adapter.promptOf('someone-else', plain);

    // Assert
    should(multi).equal('line one\nline two');
    should(after).equal('otp');
    should(missing).be.undefined();
    should(noMarker).be.undefined();
    should(noContext).be.undefined();
    should(otherSession).be.undefined();
  });
});

describe('the input card on the agenda', () => {
  it('should refuse a generic answer with use_input_form, and let the owner mark it done', async () => {
    // Arrange
    const { adapter, service } = world();
    const id = await raisedId(adapter);

    // Act
    const answered = await service.answer(SESSION, id, { kind: 'permission', decision: 'approved' } as never, HUMAN);
    const resolved = await service.resolve(SESSION, id, HUMAN);

    // Assert
    should(answered.ok).be.false();
    if (!answered.ok) should(answered.error.code).equal('use_input_form');
    should(resolved.ok).be.true();
  });

  it('should round-trip through the ledger parser with the daemon’s input-request cause', async () => {
    // Arrange
    const { adapter, repository } = world();
    await raisedId(adapter);
    const stored = repository.ledgers.get(SESSION);

    // Act
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(stored)), SESSION);

    // Assert
    should(parsed).not.be.null();
    should(parsed?.entries).have.length(1);
  });

  it('should head a daemon-raised input card with the daemon’s own words when none are given', async () => {
    // Arrange
    const { service } = world();

    // Act
    const raised = await service.raise(
      SESSION,
      {
        source: 'question',
        sourceRef: REQUEST,
        kind: 'input',
        subject: 'A value',
        why: 'A ferret asked.',
        howToResolve: 'Use the form.',
        input: { requestId: REQUEST },
      },
      { kind: 'daemon', cause: 'input-request' },
    );

    // Assert
    should(raised.ok && raised.item?.title).equal('Needs a secret');
  });
});

describe('InputCardClosedObserver', () => {
  it('should cancel the request when the owner dismisses or marks the card done', async () => {
    // Arrange
    const { adapter, service, closed } = world();
    const first = await raisedId(adapter);
    const second = await raisedId(adapter, card({ requestId: 'c'.repeat(32) }));

    // Act
    await service.dismiss(SESSION, first, HUMAN);
    await service.resolve(SESSION, second, HUMAN);

    // Assert
    should(closed).deepEqual([
      { sessionId: SESSION, id: first },
      { sessionId: SESSION, id: second },
    ]);
  });

  it('should ignore other cards, other actors and other kinds of change', async () => {
    // Arrange
    const { adapter, service, closed } = world();
    const id = await raisedId(adapter);
    const other = await service.raise(
      SESSION,
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Approve?',
        why: 'Needed.',
        howToResolve: 'Approve it.',
        ask: { kind: 'permission' },
      },
      AGENT,
    );

    // Act
    await service.dismiss(SESSION, other.ok && other.item ? other.item.id : 'A0', HUMAN);
    await service.edit(SESSION, id, { context: 'Still needed.' }, { kind: 'daemon', cause: 'input-request' });
    await adapter.close(SESSION, id, 'ended');

    // Assert
    should(closed).have.length(0);
  });
});

describe('InputAgentNotifierAdapter', () => {
  it('should queue the message under the card’s reply key, and never reject', async () => {
    // Arrange
    const queued: unknown[][] = [];
    const notifier = new InputAgentNotifierAdapter(async (...args) => {
      queued.push(args);
    });
    const broken = new InputAgentNotifierAdapter(async () => {
      throw new Error('outbox full');
    });

    // Act
    await notifier.tell(SESSION, 'A7', 'The owner typed the value.');

    // Assert
    should(queued).deepEqual([[SESSION, 'A7', 'The owner typed the value.']]);
    await should(broken.tell(SESSION, 'A7', 'x')).be.fulfilled();
  });
});
