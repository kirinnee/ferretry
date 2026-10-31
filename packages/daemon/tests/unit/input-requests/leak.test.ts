import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputEvent,
  type InputTargetFacts,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import type { AgendaLedger, AgendaLedgerRepository, AgendaMutation } from '../../../src/lib/agenda/index.ts';
import { AgendaService } from '../../../src/lib/agenda/index.ts';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import {
  InputAgendaAdapter,
  InputAgentNotifierAdapter,
  InputCardClosedObserver,
} from '../../../src/lib/input-requests/agenda-adapter.ts';
import { InputAuditAdapter } from '../../../src/lib/input-requests/audit-adapter.ts';
import { EphemeralAwareRedactor } from '../../../src/lib/input-requests/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputRequestError } from '../../../src/lib/input-requests/errors.ts';
import type { InputCaller, ObserveResult, TypeResult } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { NO_REDACTION } from '../../../src/lib/secrets/redaction.ts';
import { agent, agentToolWorld } from '../agent-tools/support.ts';

const SESSION = 's1';
const VALUE = 'Tr0ub4dor&3-LEAKPROBE';
const OTHER = 'c0rrect-horse-LEAKPROBE-2';
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const NOW = '2026-10-30T12:00:00.000Z';

const FACTS: InputTargetFacts = {
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
  recognisedConsumer: true,
};

/** Everything a value could be written as: plain, hex of its UTF-8 bytes, base64, and SHA-256 of it. */
const shapesOf = (value: string): string[] => {
  const bytes = new TextEncoder().encode(value);
  return [
    value,
    [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    Buffer.from(bytes).toString('base64'),
    createHash('sha256').update(value, 'utf8').digest('hex'),
  ];
};

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  constructor(private readonly onWrite: (bytes: string) => void) {}
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) {
      this.ledgers.set(sessionId, mutation.ledger);
      this.onWrite(JSON.stringify(mutation.ledger));
    }
    return mutation;
  }
}

/** The real input bridge, agenda, audit adapter, redactor and agent tools over recording fake sinks. */
function composed(options: { type?: () => TypeResult } = {}) {
  const emitted: { sink: string; bytes: string }[] = [];
  const record = (sink: string) => (value: unknown) =>
    void emitted.push({ sink, bytes: typeof value === 'string' ? value : JSON.stringify(value) });
  const now = { ms: Date.parse(NOW) };
  const clock = { now: () => now.ms };
  const values = new EphemeralValues(clock);
  const redactor = new EphemeralAwareRedactor(NO_REDACTION, values);
  let service: InputRequestService | undefined;
  const live = (): InputRequestService => {
    if (service === undefined) throw new Error('the service is not built yet');
    return service;
  };
  const tools = agentToolWorld({
    input: {
      raise: async (sessionId, raise) => await live().raise(sessionId, raise),
      agentView: async (sessionId, id, waitMs) => await live().agentView(sessionId, id, waitMs),
      pendingOn: (sessionId, target) => live().pendingOn(sessionId, target),
      exclusive: async (sessionId, work) => await live().exclusive(sessionId, work),
    },
    scrub: (sessionId, text) => live().scrub(sessionId, text),
  });
  const agenda = new AgendaService(
    new MemoryRepository(record('fs:agenda-ledger')),
    { now: () => new Date(now.ms).toISOString() },
    { has: async id => id === SESSION },
    { raised: async (...args: unknown[]) => void record('push:agenda-raised')(args) },
    new InputCardClosedObserver(async (sessionId, id) => await live().cardDismissed(sessionId, id)),
  );
  let id = 1;
  const journal: InputEvent[] = [];
  service = new InputRequestService({
    target: {
      observe: async (): Promise<ObserveResult> => ({ ok: true, facts: FACTS }),
      type: async (sessionId, _target, values, submit) => {
        const result = options.type?.() ?? 'typed';
        const text = values.map(value => value.text).join('');
        const terminal = (await tools.terminals.list(sessionId)).terminals[0];
        if (terminal !== undefined)
          await tools.terminals.write(sessionId, terminal.id, new TextEncoder().encode(`${text}${submit ? '\r' : ''}`));
        return result;
      },
    },
    agenda: new InputAgendaAdapter(agenda),
    notifier: new InputAgentNotifierAdapter(
      async (sessionId, key, message) => void record('push:agent-reply')({ sessionId, key, message }),
    ),
    journal: {
      publish: async (_session, event) => {
        journal.push(event);
        record('fs:session-journal')(event);
      },
      history: async () => journal,
      quarantine: async () => undefined,
      quarantines: async () => [],
    },
    audit: new InputAuditAdapter({ record: async (entry: AuditEntry) => void record('fs:audit-log')(entry) }),
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== SESSION, all: async () => [SESSION] },
    values,
    quarantine: new QuarantineRegistry(clock),
    redact: async text => await redactor.redact(text),
  });
  return { service, tools, agenda, emitted, now, values, record };
}

const bodyFor = (digest: string, value: string, over: Partial<InputDeliverBody> = {}): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  padded: padInputValue(value),
  submit: true,
  ...over,
});

const settle = async (work: Promise<unknown>) =>
  await work.then(
    value => value,
    (error: unknown) => error,
  );

describe('the value reaches the terminal and nowhere else, over the real adapters', () => {
  it('should emit no byte of the value through any sink across deliver, error, closure, follow-up and read paths', async () => {
    const { service, tools, agenda, emitted, now, record, values } = composed();
    const logged: string[] = [];
    const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const name of ['log', 'error', 'warn', 'info'] as const)
      console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    const results: unknown[] = [];
    try {
      const call = async (input: Parameters<typeof tools.service.call>[1]) => {
        const out = await settle(tools.service.call(agent, input));
        results.push(out instanceof Error ? out.message : out);
        record('agent-tool-result')(out instanceof Error ? out.message : out);
        return out;
      };

      await call({ tool: 'terminal.open', name: 'dev' });
      await call({
        tool: 'terminal.request_input',
        name: 'dev',
        prompt: 'sudo wants your password',
        sensitivity: 'secret',
      });
      const [first] = await service.list(HOST);
      record('operator-read')(await service.list(HOST));
      await call({ tool: 'terminal.send', name: 'dev', text: 'whoami' });

      // refusals carrying nothing of the value
      const wrong = await settle(service.deliver(SESSION, first?.id ?? '', bodyFor('f'.repeat(64), VALUE), HOST));
      record('refusal')(wrong instanceof Error ? wrong.message : wrong);
      const agentTry = await settle(
        service.deliver(SESSION, first?.id ?? '', bodyFor(first?.observedDigest ?? '', VALUE), {
          kind: 'agent',
          sessionId: SESSION,
        }),
      );
      record('refusal')(agentTry instanceof Error ? agentTry.message : agentTry);

      // delivery
      const delivered = await service.deliver(
        SESSION,
        first?.id ?? '',
        bodyFor(first?.observedDigest ?? '', VALUE),
        HOST,
      );
      record('deliver-result')(delivered);

      // follow-up and reads, while the window is open
      await call({ tool: 'input.wait', id: first?.agendaItemId ?? 'A1' });
      await call({ tool: 'terminal.read', name: 'dev' });
      await call({ tool: 'terminal.wait', name: 'dev', text: VALUE, timeoutMs: 100 });
      await call({ tool: 'terminal.wait', name: 'dev', text: VALUE.slice(0, 6), timeoutMs: 100 });
      record('operator-read')(await service.list(HOST));
      record('operator-read')(await service.list(HOST, SESSION));

      // an owner note carrying the value through the card must not reach the ledger
      await call({ tool: 'terminal.request_input', name: 'dev', prompt: 'second', sensitivity: 'secret' });
      const [second] = await service.list(HOST);
      const closed = await agenda.resolve(
        SESSION,
        (second?.agendaItemId ?? 'A2') as AgendaId,
        { kind: 'human' },
        OTHER,
      );
      record('closure')(closed);
      await call({ tool: 'terminal.read', name: 'dev' });

      await call({ tool: 'terminal.close', name: 'dev' });

      // the window ends and the sweep prunes
      now.ms += 3_600_000;
      await service.sweep();
      should(values.heldCount()).equal(0);
    } finally {
      Object.assign(console, originals);
    }

    const typedInTerminal = [...tools.terminals.typed.values()].join('');
    const reads = results.map(result => JSON.stringify(result)).join('\n');
    should(typedInTerminal.includes(VALUE)).equal(true);
    should(reads.includes('[redacted:input')).equal(true);
    const everything = [...emitted.map(entry => entry.bytes), ...logged].join('\n');
    for (const secret of [VALUE, OTHER])
      for (const shape of shapesOf(secret)) should(everything.includes(shape)).equal(false);
    should(new Set(emitted.map(entry => entry.sink)).size).be.aboveOrEqual(8);
  });

  it('should keep the value out of the interrupted-delivery path and a restore after it', async () => {
    const { service, emitted, tools } = composed({ type: () => 'uncertain' });
    await tools.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    await tools.service.call(agent, {
      tool: 'terminal.request_input',
      name: 'dev',
      prompt: 'p',
      sensitivity: 'secret',
    });
    const [request] = await service.list(HOST);
    const failed = await settle(
      service.deliver(SESSION, request?.id ?? '', bodyFor(request?.observedDigest ?? '', VALUE), HOST),
    );
    const view = await service.agentView(SESSION, (request?.agendaItemId ?? 'A1') as AgendaId, 0);

    should(failed).be.instanceOf(InputRequestError);
    should(view.state).not.equal('pending');
    const everything = [
      ...emitted.map(entry => entry.bytes),
      JSON.stringify(view),
      String((failed as Error).message),
    ].join('\n');
    for (const shape of shapesOf(VALUE)) should(everything.includes(shape)).equal(false);
  });
});
