import { describe, it } from 'bun:test';
import { type AgendaId, type InputDeliverBody, type InputEvent, padInputValue } from '@ferretry/protocol';
import should from 'should';
import {
  RedactingTerminalStreamService,
  TerminalStreamBridge,
  type TerminalStreamDownstream,
  type TerminalStreamScheduler,
  type TerminalStreamService,
  TmuxTerminalRuntime,
} from '../../../src/adapters/index.ts';
import { EphemeralAwareRedactor } from '../../../src/lib/input-requests/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import type { InputAuditEntry, InputCaller } from '../../../src/lib/input-requests/ports.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { TmuxInputTarget } from '../../../src/lib/input-requests/terminal-target.ts';
import { NO_REDACTION, type TextRedactor } from '../../../src/lib/secrets/redaction.ts';
import type { TerminalRecord } from '../../../src/lib/terminal/contracts.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';

/**
 * The value must be unfindable by anyone but the program it was typed into, over the REAL tmux input target,
 * the REAL tmux text and capture adapters, the REAL stream bridge behind its redacting decorator and the REAL
 * service, with only tmux itself, ps and the clock faked. The pane shows the value echoed back in several
 * shapes a program really produces: plain, with trailing spaces, wrapped over two rows, and in colour.
 */

const SESSION = 's1';
const TMUX = 'fy-webterm-Hadi-0a1b2c3d-abc123abc123';
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const ESC = '\u001b';
const PS = ' 4242  4242  4300 bash -bash\n 4300  4300  4300 sudo sudo -v\n';
const RECORD: TerminalRecord = {
  id: 'aabbccddeeff',
  ownerId: 'o1',
  title: 'dev',
  root: '/tmp',
  tmuxSession: TMUX,
  createdAtMs: 1,
  lastActivityAtMs: 1,
  cols: 20,
  rows: 5,
};

interface Scenario {
  readonly name: string;
  readonly value: string;
  readonly physical: (value: string) => readonly string[];
  readonly joined: (value: string) => readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'plain', value: 'Tr0ub4dor&3-LEAKPROBE', physical: v => [`Password: ${v}`], joined: v => [`Password: ${v}`] },
  {
    name: 'trailing spaces',
    value: 'sp ace-LEAKPROBE  ',
    physical: v => [`pw: ${v}`],
    joined: v => [`pw: ${v}`],
  },
  {
    name: 'wrapped over two rows',
    value: 'Tr0ub4dor&3-LEAKPROBE',
    physical: v => [`Password: ${v.slice(0, 7)}`, v.slice(7)],
    joined: v => [`Password: ${v}`],
  },
  {
    name: 'in colour',
    value: 'Tr0ub4dor&3-LEAKPROBE',
    physical: v => [`${ESC}[31mPassword: ${v}${ESC}[0m`],
    joined: v => [`Password: ${v}`],
  },
];

interface Pane {
  physical: readonly string[];
  joined: readonly string[];
  argv: string;
  failWrite: boolean;
  typed: string[];
}

const ok = (stdout: string): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const unhex = (tokens: readonly string[]): string =>
  new TextDecoder().decode(Uint8Array.from(tokens.map(token => Number.parseInt(token, 16))));

function fakeTmux(pane: Pane): TmuxCommandPort {
  return {
    execute: async args => {
      if (args[0] === 'display-message') return ok(`%3|4242|0|1700000000\t/dev/pts/9\t0\tsudo\n`);
      if (args[0] === 'capture-pane' && args.includes(';'))
        return ok(`${pane.physical.join('\n')}\n0|0|20|${pane.physical.length}|0\n`);
      if (args[0] === 'capture-pane' && args.includes('-J')) return ok(`${pane.joined.join('\n')}\n\n\n`);
      if (args[0] === 'capture-pane')
        return ok(`${(pane.physical[0] ?? '').replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'gu'), '')}\n`);
      if (args[0] === 'if-shell') {
        if (pane.failWrite) return { code: 1, stdout: '', stderr: 'no server' };
        pane.typed.push(unhex(String(args[5]).split(' ').slice(4)));
        return ok('');
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
}

function composed(scenario: Scenario, options: { history?: readonly InputEvent[]; failWrite?: boolean } = {}) {
  const pane: Pane = {
    physical: ['[sudo] password for kirin:'],
    joined: ['[sudo] password for kirin:'],
    argv: 'sudo -v',
    failWrite: options.failWrite ?? false,
    typed: [],
  };
  const tmux = fakeTmux(pane);
  const runtime = new TmuxTerminalRuntime(tmux, () => 1, { shell: async () => '/bin/sh' } as never);
  const clock = { now: () => Date.parse('2026-10-30T12:00:00.000Z') };
  const values = new EphemeralValues(clock);
  const redactor = new EphemeralAwareRedactor(NO_REDACTION, values);
  const emitted: string[] = [];
  const events: InputEvent[] = [...(options.history ?? [])];
  let card = 1;
  let id = 1;
  const service = new InputRequestService({
    target: new TmuxInputTarget(
      tmux,
      { locate: async () => ({ tmuxSession: TMUX }) },
      { echo: async () => 'off' },
      async () => PS.replace('sudo -v', pane.argv),
    ),
    agenda: {
      raise: async (_session, cardBody) => {
        emitted.push(JSON.stringify(cardBody));
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, closed, note) => void emitted.push(`${closed} ${note}`),
      promptOf: async () => 'sudo wants your password',
    },
    notifier: { tell: async (_session, tellId, message) => void emitted.push(`${tellId} ${message}`) },
    journal: {
      publish: async (_session, event) => {
        events.push(event);
        emitted.push(JSON.stringify(event));
      },
      history: async () => events,
    },
    audit: { record: async (entry: InputAuditEntry) => void emitted.push(JSON.stringify(entry)) },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    trusted: { isTrusted: () => false, trust: () => undefined },
    sessions: { ended: async () => false, all: async () => [SESSION] },
    values,
    redact: async text => await redactor.redact(text),
  });
  const underlying: TerminalStreamService = {
    write: async () => undefined,
    resize: async () => undefined,
    capture: async (_session, _terminal, history) => await runtime.capture(RECORD, history),
  };
  return { pane, runtime, service, values, redactor, emitted, events, underlying, scenario };
}

const RAISE = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
} as const;

const bodyFor = (digest: string, value: string): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  padded: padInputValue(value),
  submit: true,
});

/** The pieces of a value an eye or a grep could match: whole, its first six characters and its last nine. */
const piecesOf = (value: string): string[] => [value.trim(), value.slice(0, 6), value.trim().slice(-9)];

async function streamed(service: TerminalStreamService): Promise<{ frames: string; closed: number }> {
  const frames: string[] = [];
  let closed = 0;
  const downstream: TerminalStreamDownstream = {
    send: bytes => {
      frames.push(new TextDecoder().decode(bytes));
      return bytes.length;
    },
    close: () => {
      closed += 1;
    },
  };
  const scheduler: TerminalStreamScheduler = { schedule: () => ({ cancel: () => undefined }) };
  const bridge = new TerminalStreamBridge(service, SESSION, RECORD.id, downstream, scheduler);
  await bridge.open();
  bridge.close();
  return { frames: frames.join('\n'), closed };
}

async function typedInto(world: ReturnType<typeof composed>): Promise<void> {
  await world.service.raise(SESSION, RAISE);
  const [request] = await world.service.list(HOST);
  await world.service.deliver(
    SESSION,
    request?.id ?? '',
    bodyFor(request?.observedDigest ?? '', world.scenario.value),
    HOST,
  );
  world.pane.physical = world.scenario.physical(world.scenario.value);
  world.pane.joined = world.scenario.joined(world.scenario.value);
}

describe('the value is unfindable outside the program it was typed into, over the real adapters', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      it('should type the value once and then mask it from the text read, whole', async () => {
        const world = composed(scenario);
        await typedInto(world);
        const text = world.service.scrub(SESSION, await world.runtime.text(RECORD, 50));

        should(world.pane.typed.length).equal(1);
        should(world.pane.typed[0]?.startsWith(scenario.value)).be.true();
        should(text).containEql('[redacted:input');
        for (const piece of piecesOf(scenario.value)) should(text).not.containEql(piece);
      });

      it('should draw the viewer’s stream masked, and show the control without the decorator really holds the value', async () => {
        const world = composed(scenario);
        await typedInto(world);
        const masked = await streamed(new RedactingTerminalStreamService(world.underlying, world.redactor));
        const raw = await streamed(world.underlying);

        should(masked.frames).containEql('[redacted:input');
        for (const piece of piecesOf(scenario.value)) should(masked.frames).not.containEql(piece);
        should(raw.frames).containEql(scenario.value.trim().slice(-9));
      });

      it('should show a later request, its card, journal, audit and agent notes nothing of the echoed value', async () => {
        const world = composed(scenario);
        await typedInto(world);
        await world.service.raise(SESSION, RAISE);
        const listed = JSON.stringify(await world.service.list(HOST));
        const everything = [listed, ...world.emitted].join('\n');

        for (const piece of piecesOf(scenario.value)) should(everything).not.containEql(piece);
      });
    });
  }

  it('should keep a program name or argv carrying the value out of every view and record', async () => {
    const scenario = SCENARIOS[0] as Scenario;
    const world = composed(scenario);
    await typedInto(world);
    world.pane.argv = `sudo --password=${scenario.value}`;
    await world.service.raise(SESSION, RAISE);
    const everything = [JSON.stringify(await world.service.list(HOST)), ...world.emitted].join('\n');

    should(everything).containEql('sudo --password=[redacted:input');
    for (const piece of piecesOf(scenario.value)) should(everything).not.containEql(piece);
  });

  it('should close the stream and draw nothing when the redactor cannot run', async () => {
    const world = composed(SCENARIOS[0] as Scenario);
    await typedInto(world);
    const broken: TextRedactor = {
      redact: async () => Promise.reject(new Error('vault locked')),
      redactData: async () => Promise.reject(new Error('vault locked')),
      batch: async () => Promise.reject(new Error('vault locked')),
    };
    const result = await streamed(new RedactingTerminalStreamService(world.underlying, broken));

    should(result.frames).equal('');
  });

  it('should leak nothing through an uncertain write and the restore that follows it', async () => {
    const scenario = SCENARIOS[0] as Scenario;
    const world = composed(scenario, { failWrite: true });
    await world.service.raise(SESSION, RAISE);
    const [request] = await world.service.list(HOST);
    const failed = await world.service
      .deliver(SESSION, request?.id ?? '', bodyFor(request?.observedDigest ?? '', scenario.value), HOST)
      .then(
        () => 'delivered',
        (error: unknown) => (error as Error).message,
      );
    const restored = composed(scenario, { history: world.events });
    await restored.service.restore();
    const everything = [
      failed,
      ...world.emitted,
      ...restored.emitted,
      JSON.stringify(await restored.service.list(HOST)),
    ];

    should(world.pane.typed.length).equal(0);
    should((await restored.service.list(HOST)).length).equal(0);
    for (const piece of piecesOf(scenario.value)) should(everything.join('\n')).not.containEql(piece);
  });
});
