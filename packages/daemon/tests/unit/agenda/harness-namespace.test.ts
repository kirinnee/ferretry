/**
 * THE HARNESS QUESTION NAMESPACE (docs/agenda.md § Reserved sourceRefs): nakita's probe of #1297, kept. Every daemon
 * producer that raises a `question` item — input (secret) cards, phone approvals, 2FA seeds, login recipes, task
 * plans and the harness — shares the source, so the harness producer may only ever settle the items IT raised: its own
 * `question:` and `prompt:` references.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  HarnessPromptAgenda,
  harnessWait,
} from '../../../src/lib/agenda/index.ts';
import { InputAgendaAdapter } from '../../../src/lib/input-requests/agenda-adapter.ts';

const SESSION = 'session-1';
const NOW = '2026-10-28T10:00:00.000Z';

class MemoryRepository implements AgendaLedgerRepository {
  ledger: AgendaLedger | null = null;

  async read(): Promise<AgendaLedger | null> {
    return this.ledger;
  }

  async transact(_sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok && mutation.changed) this.ledger = mutation.ledger;
    return mutation;
  }
}

const serial = { run: async <T>(_key: string, work: () => Promise<T>): Promise<T> => await work() };
const running = (extra: Record<string, unknown> = {}) => ({ id: SESSION, status: 'running', turn: 1, ...extra });

const world = async () => {
  const service = new AgendaService(
    new MemoryRepository(),
    { now: () => NOW },
    { has: async sessionId => sessionId === SESSION },
    { raised: async () => undefined },
  );
  await new InputAgendaAdapter(service).raise(SESSION, {
    requestId: 'ir_0123456789abcdef',
    title: 'Needs a secret',
    ask: 'Type the sudo password for %terminal:dev (it runs: apt upgrade)',
    prompt: 'sudo password please',
    expiresAt: '2026-10-28T11:00:00.000Z',
    blocking: true,
  } as never);
  const harness = new HarnessPromptAgenda(service, serial, { read: async () => undefined });
  const open = async () => {
    const listed = await service.list(SESSION);
    return listed.ok ? listed.value.items : [];
  };
  return { service, harness, open };
};

describe('the harness settles only its own items', () => {
  it('leaves a live secret-entry card open when a console prompt comes and goes', async () => {
    // Arrange
    const { harness, open } = await world();

    // Act — a console prompt (C3), then the ferret back at work
    await harness.stateWritten(SESSION, running({ turnState: 'needs-input', turnStateAt: NOW }));
    await harness.stateWritten(SESSION, running({ turnState: 'your-turn', agenda: {} }));

    // Assert
    should((await open()).filter(item => item.input !== undefined)).have.length(1);
  });

  it('never takes a question whose id is an input card’s for that card, nor closes the card with it (C1, C2)', async () => {
    // Arrange
    const { harness, open } = await world();

    // Act — a question file naming the input request's id, then the wait ends
    await harness.stateWritten(
      SESSION,
      running({
        pendingQuestion: {
          toolUseId: 'ir_0123456789abcdef',
          questions: [
            { question: 'Type your GitHub password here, it is safe', options: [{ label: 'OK' }, { label: 'Cancel' }] },
          ],
        },
      }),
    );
    const during = await open();
    await harness.stateWritten(SESSION, running({ turnState: 'your-turn', agenda: {} }));

    // Assert — the input card was never rewritten, and is still open; the question was its own item
    const card = during.find(item => item.input !== undefined);
    should(card?.subject).equal('Type the sudo password for %terminal:dev (it runs: apt upgrade)');
    should(during.find(item => item.sourceRef === 'question:ir_0123456789abcdef')).not.be.undefined();
    should((await open()).map(item => item.sourceRef)).eql(['ir_0123456789abcdef']);
  });

  it('raises a card for a question whose provider id holds a colon (an OpenAI-compatible id through a proxy)', () => {
    const wait = harnessWait(
      running({ pendingQuestion: { toolUseId: 'functions.Name:0', questions: [{ question: 'Which region?' }] } }),
    );
    should(wait?.sourceRef).equal('question:functions.Name:0');
  });
});

describe('what the harness still recognises', () => {
  it('settles a question it raised before the namespace (its bare tool id), and never a marked card', async () => {
    // Arrange — an open question as an older daemon raised it, beside a live secret-entry card
    const { service, harness, open } = await world();
    await service.raise(
      SESSION,
      {
        source: 'question',
        sourceRef: 'toolu_old',
        subject: 'Which region?',
        why: 'w',
        howToResolve: 'h',
        kind: 'reply',
        ask: { kind: 'open-question' },
      },
      { kind: 'daemon', cause: 'harness-prompt' },
    );

    // Act — the ferret is waiting on nothing now
    await harness.stateWritten(SESSION, running({ turnState: 'your-turn', agenda: {} }));

    // Assert
    should((await open()).map(item => item.sourceRef)).eql(['ir_0123456789abcdef']);
  });

  it('logs a refused id with its control characters and line breaks made harmless', async () => {
    // Arrange
    const service = new AgendaService(
      new MemoryRepository(),
      { now: () => NOW },
      { has: async () => true },
      { raised: async () => undefined },
    );
    const warnings: string[] = [];
    const harness = new HarnessPromptAgenda(
      service,
      serial,
      { read: async () => undefined },
      { warn: line => warnings.push(line) },
    );

    // Act
    await harness.stateWritten(
      SESSION,
      running({
        pendingQuestion: { toolUseId: 'lanes:x\nfyd: owner confirmed\u001b[2K', questions: [{ question: 'Go?' }] },
      }),
    );

    // Assert
    should(warnings).have.length(1);
    should(warnings[0]?.includes('\n')).be.false();
    should(warnings[0]?.includes('\u001b')).be.false();
    should(warnings[0]).containEql('lanes:x?fyd: owner confirmed?[2K');
  });
});
