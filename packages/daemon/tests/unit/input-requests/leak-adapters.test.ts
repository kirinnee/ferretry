import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputEvent,
  type InputQuarantineEvent,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import {
  RedactingTerminalStreamService,
  TerminalStreamBridge,
  type TerminalStreamDownstream,
  type TerminalStreamScheduler,
  type TerminalStreamService,
  TmuxTerminalRuntime,
} from '../../../src/adapters/index.ts';
import { digestLine } from '../../../src/lib/input-requests/digest.ts';
import { EphemeralAwareRedactor } from '../../../src/lib/input-requests/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import type { InputAuditEntry, InputCaller } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { TmuxInputTarget } from '../../../src/lib/input-requests/terminal-target.ts';
import { NO_REDACTION, SecretRedactor, type TextRedactor } from '../../../src/lib/secrets/redaction.ts';
import type { SecretVault } from '../../../src/lib/secrets/vault.ts';
import { OperatorReadService } from '../../../src/lib/session/reads/service.ts';
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
  readonly cols: number;
  /** The rows tmux holds, each cut at the pane width as a terminal wraps them. */
  readonly physical: (value: string) => readonly string[];
  readonly joined: (value: string) => readonly string[];
}

const wrap = (text: string, cols: number): string[] =>
  text.length <= cols ? [text] : [text.slice(0, cols), ...wrap(text.slice(cols), cols)];

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'plain',
    value: 'Tr0ub4dor&3-LEAKPROBE',
    cols: 40,
    physical: v => [`Password: ${v}`],
    joined: v => [`Password: ${v}`],
  },
  {
    name: 'trailing spaces',
    value: 'sp ace-LEAKPROBE  ',
    cols: 40,
    physical: v => [`pw: ${v}`],
    joined: v => [`pw: ${v}`],
  },
  {
    name: 'trailing spaces that wrap onto a row of their own',
    value: 'sp ace-LEAKPROBE  ',
    cols: 20,
    physical: v => wrap(`pw: ${v}`, 20),
    joined: v => [`pw: ${v}`],
  },
  {
    name: 'wrapped over two rows',
    value: 'Tr0ub4dor&3-LEAKPROBE',
    cols: 20,
    physical: v => wrap(`Password: ${v}`, 20),
    joined: v => [`Password: ${v}`],
  },
  {
    name: 'in colour',
    value: 'Tr0ub4dor&3-LEAKPROBE',
    cols: 40,
    physical: v => [`${ESC}[31mPassword: ${v}${ESC}[0m`],
    joined: v => [`Password: ${v}`],
  },
  {
    name: 'a short value ending in a space',
    value: 'qz ',
    cols: 40,
    physical: v => [`pw: ${v}`],
    joined: v => [`pw: ${v}`],
  },
];

interface Pane {
  physical: readonly string[];
  joined: readonly string[];
  argv: string;
  failWrite: boolean;
  typed: string[];
  cols: number;
  comm: string;
}

const ok = (stdout: string): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const unhex = (tokens: readonly string[]): string =>
  new TextDecoder().decode(Uint8Array.from(tokens.map(token => Number.parseInt(token, 16))));

const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const visibleWidth = (row: string): number => row.replaceAll(SGR, '').length;
/** What tmux does to a row unless asked not to (-N): the spaces ending it go, even before a trailing colour reset. */
const trimmed = (row: string): string => row.replace(new RegExp(` +((?:${ESC}\\[[0-9;]*m)*)$`, 'u'), '$1');
/** And what it does with -N: the row is the full width of the pane. */
const padded = (row: string, cols: number): string => row + ' '.repeat(Math.max(0, cols - visibleWidth(row)));

function fakeTmux(pane: Pane): TmuxCommandPort {
  const rows = (args: readonly string[]): string[] =>
    pane.physical.map(row => (args.includes('-N') ? padded(row, pane.cols) : trimmed(row)));
  return {
    execute: async args => {
      if (args[0] === 'display-message' && !args.includes('-p')) return { code: 1, stdout: '', stderr: 'bad' };
      if (args[0] === 'display-message') return ok(`%3|4242|0|1700000000\t/dev/pts/9\t0\t${pane.comm}\n`);
      if (args[0] === 'capture-pane' && args.includes(';'))
        return ok(`${rows(args).join('\n')}\n0|0|${pane.cols}|${pane.physical.length}|0\n`);
      if (args[0] === 'capture-pane' && args.includes('-J')) return ok(`${pane.joined.join('\n')}\n\n\n`);
      if (args[0] === 'capture-pane') return ok(`${rows(args)[0]?.replaceAll(SGR, '') ?? ''}\n`);
      if (args[0] === 'if-shell') {
        if (pane.failWrite) return { code: 1, stdout: '', stderr: 'no server' };
        pane.typed.push(unhex(String(args[5]).split(' ').slice(4)));
        return ok('');
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
}

function composed(
  scenario: Scenario,
  options: {
    history?: readonly InputEvent[];
    failWrite?: boolean;
    vault?: TextRedactor;
    quarantineLog?: InputQuarantineEvent[];
    clockAt?: number;
  } = {},
) {
  const trusted = new Set<string>();
  const pane: Pane = {
    physical: ['[sudo] password for kirin:'],
    joined: ['[sudo] password for kirin:'],
    argv: 'sudo -v',
    failWrite: options.failWrite ?? false,
    typed: [],
    cols: scenario.cols,
    comm: 'sudo',
  };
  const tmux = fakeTmux(pane);
  const runtime = new TmuxTerminalRuntime(tmux, () => 1, { shell: async () => '/bin/sh' } as never);
  let nowMs = options.clockAt ?? Date.parse('2026-10-30T12:00:00.000Z');
  const clock = { now: () => nowMs };
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  const values = new EphemeralValues(clock);
  const redactor = new EphemeralAwareRedactor(options.vault ?? NO_REDACTION, values);
  const quarantine = new QuarantineRegistry(clock);
  const quarantineLog = options.quarantineLog ?? [];
  const emitted: string[] = [];
  const events: InputEvent[] = [...(options.history ?? [])];
  let card = 1;
  let id = 1;
  const service = new InputRequestService({
    target: new TmuxInputTarget(
      tmux,
      { locate: async () => ({ tmuxSession: TMUX }) },
      { echo: async () => 'off' },
      async () => PS.replace('sudo sudo -v', `${pane.comm} ${pane.argv}`),
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
      quarantine: async (_session, event) => void quarantineLog.push(event),
      quarantines: async () => quarantineLog,
    },
    audit: { record: async (entry: InputAuditEntry) => void emitted.push(JSON.stringify(entry)) },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    trusted: { isTrusted: digest => trusted.has(digest), trust: digest => void trusted.add(digest) },
    sessions: { ended: async () => false, all: async () => [SESSION] },
    values,
    quarantine,
    redact: async text => await redactor.redact(text),
  });
  const underlying: TerminalStreamService = {
    write: async () => undefined,
    resize: async () => undefined,
    capture: async (_session, _terminal, history) => await runtime.capture(RECORD, history),
  };
  const reader = new OperatorReadService(
    {} as never,
    { capture: async () => ({ alive: true, dead: false, text: await runtime.text(RECORD, 50) }) },
    {} as never,
    {} as never,
    {} as never,
    undefined,
    redactor,
  );
  return {
    pane,
    runtime,
    service,
    values,
    redactor,
    emitted,
    events,
    underlying,
    scenario,
    trusted,
    reader,
    advance,
    quarantine,
  };
}

const RAISE = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
} as const;

const bodyFor = (digest: string, value: string, trustProgram = false): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  padded: padInputValue(value),
  submit: true,
  ...(trustProgram ? { trustProgram: true } : {}),
});

/** The pieces of a value an eye or a grep could match: whole, its first six characters and its last nine. */
const piecesOf = (value: string): string[] => [value.trim(), value.slice(0, 6), value.trim().slice(-9)];

/** Opens a viewer, then lets `polls` more captures happen, `between` each one: the open frame, then deltas. */
async function streamed(
  service: TerminalStreamService,
  options: { polls?: number; between?: () => void; resize?: { cols: number; rows: number } } = {},
): Promise<{ frames: string; closed: number; sent: readonly string[] }> {
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
  let pending: (() => void) | undefined;
  const scheduler: TerminalStreamScheduler = {
    schedule: callback => {
      pending = callback;
      return { cancel: () => undefined };
    },
  };
  const bridge = new TerminalStreamBridge(service, SESSION, RECORD.id, downstream, scheduler);
  await bridge.open();
  if (options.resize !== undefined) {
    bridge.fromClient(JSON.stringify({ type: 'resize', ...options.resize }));
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  for (let poll = 0; poll < (options.polls ?? 0); poll += 1) {
    options.between?.();
    pending?.();
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  bridge.close();
  return { frames: frames.join('\n'), closed, sent: frames };
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

        should(masked.frames).containEql('*');
        for (const piece of piecesOf(scenario.value)) should(masked.frames).not.containEql(piece);
        should(raw.frames).containEql(scenario.value.trim().slice(-9));
      });

      it('should keep the value out of every delta frame when the echo arrives after the viewer opened', async () => {
        const world = composed(scenario);
        await typedInto(world);
        const echoed = world.pane.physical;
        world.pane.physical = ['[sudo] password for kirin:'];
        const masked = await streamed(new RedactingTerminalStreamService(world.underlying, world.redactor), {
          polls: 3,
          between: () => {
            world.pane.physical = echoed;
          },
        });

        should(masked.frames).containEql('*');
        for (const piece of piecesOf(scenario.value)) should(masked.frames).not.containEql(piece);
      });

      it('should keep the masked screen the shape of the real one: the same rows, within the same columns', async () => {
        const world = composed(scenario);
        await typedInto(world);
        const real = await world.underlying.capture(SESSION, RECORD.id, 50);
        const masked = await new RedactingTerminalStreamService(world.underlying, world.redactor).capture(
          SESSION,
          RECORD.id,
          50,
        );

        should(masked.lines.length).equal(real.lines.length);
        should(masked.cols).equal(real.cols);
        should(masked.cursorX).equal(real.cursorX);
        for (const row of masked.lines) should(row.replaceAll(SGR, '').length).be.belowOrEqual(real.cols);
      });

      it('should mask the value from the operator’s screen read', async () => {
        const world = composed(scenario);
        await typedInto(world);
        const screen = await world.reader.snapshot(SESSION);

        should(screen).containEql('[redacted:input');
        for (const piece of piecesOf(scenario.value)) should(screen).not.containEql(piece);
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

    should(everything).not.containEql('sudo --password');
    for (const piece of piecesOf(scenario.value)) should(everything).not.containEql(piece);
  });

  it('should mask held values that interact, and a held value beside a vault secret, from the stream', async () => {
    const scenario = SCENARIOS[0] as Scenario;
    const world = composed(scenario);
    await typedInto(world);
    world.values.hold(SESSION, ':', 'A2');
    world.values.hold(SESSION, 'LEAKPROBE', 'A3');
    const masked = await streamed(new RedactingTerminalStreamService(world.underlying, world.redactor), { polls: 1 });

    should(masked.frames).not.containEql('LEAKPROBE');
    should(masked.frames).not.containEql('Tr0ub4dor');
    should(masked.frames).not.containEql(':');
  });

  it('should keep a program name the owner typed earlier out of every view, record and the trusted-program memory', async () => {
    const scenario: Scenario = { ...(SCENARIOS[0] as Scenario), value: 'Tr0ub4dor3-LEAKPROBE' };
    const world = composed(scenario);
    await typedInto(world);
    world.pane.comm = scenario.value;
    world.pane.argv = scenario.value;
    await world.service.raise(SESSION, RAISE);
    const [request] = await world.service.list(HOST);
    await world.service.deliver(
      SESSION,
      request?.id ?? '',
      bodyFor(request?.observedDigest ?? '', 'other', true),
      HOST,
    );
    world.advance(2 * 60 * 60 * 1000);
    await world.service.sessionEnded(SESSION);
    const everything = [JSON.stringify(await world.service.list(HOST)), ...world.emitted, ...world.trusted].join('\n');

    should(world.trusted.size).equal(1);
    should(world.trusted.has(digestLine(scenario.value))).be.true();
    should(world.values.heldCount()).equal(0);
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

const FULL_REDRAW = `${ESC}[3J${ESC}[2J${ESC}[H`;
const QUARANTINE_NOTICE = 'Kept from view';

describe('the quarantine is the boundary, over the real adapters (masking is only behind it)', () => {
  const scenario = SCENARIOS[0] as Scenario;
  const gateOf = (world: ReturnType<typeof composed>) => (session: string, terminal: string) =>
    world.service.quarantinedUntil(session, [terminal, RECORD.title]);

  it('should show the viewer a notice and not one byte of the pane while the quarantine runs, full and delta', async () => {
    const world = composed(scenario);
    await typedInto(world);
    const view = new RedactingTerminalStreamService(world.underlying, world.redactor, gateOf(world), () => 1);
    const echoed = world.pane.physical;
    world.pane.physical = ['[sudo] password for kirin:'];
    const result = await streamed(view, {
      polls: 3,
      resize: { cols: scenario.cols, rows: 5 },
      between: () => {
        world.pane.physical = echoed;
      },
    });

    should(result.frames).containEql(QUARANTINE_NOTICE);
    should(result.frames).not.containEql('sudo');
    for (const piece of piecesOf(scenario.value)) should(result.frames).not.containEql(piece);
  });

  it('should send a real delta frame once the viewer has said how big it is, and keep the value out of it', async () => {
    const world = composed(scenario);
    await typedInto(world);
    world.quarantine.end(SESSION, 'dev');
    const view = new RedactingTerminalStreamService(world.underlying, world.redactor);
    const screen = (rows: readonly string[]): string[] => [...rows, '', '', '', ''].slice(0, 5);
    const echoed = screen(world.pane.physical);
    world.pane.physical = screen(['[sudo] password for kirin:']);
    let poll = 0;
    const result = await streamed(view, {
      polls: 3,
      resize: { cols: scenario.cols, rows: 5 },
      between: () => {
        poll += 1;
        world.pane.physical = poll === 1 ? echoed : echoed.map(row => row.replace('Password', `Pass${poll}ord`));
      },
    });

    should(result.sent.some(frame => frame !== '' && !frame.startsWith(FULL_REDRAW))).be.true();
    should(result.frames).containEql('*');
    for (const piece of piecesOf(scenario.value)) should(result.frames).not.containEql(piece);
  });

  it('should show the value to a viewer that chose to reveal it, and only to that viewer', async () => {
    const world = composed(scenario);
    await typedInto(world);
    const revealed = await streamed(new RedactingTerminalStreamService(world.underlying, world.redactor));
    const hidden = await streamed(
      new RedactingTerminalStreamService(world.underlying, world.redactor, gateOf(world), () => 1),
    );

    should(revealed.frames).not.containEql(QUARANTINE_NOTICE);
    should(hidden.frames).containEql(QUARANTINE_NOTICE);
  });

  it('should keep the quarantine across a restart after a SUCCESSFUL write, and let it end on time', async () => {
    const log: InputQuarantineEvent[] = [];
    const world = composed(scenario, { quarantineLog: log });
    await typedInto(world);
    const restarted = composed(scenario, { quarantineLog: log, history: world.events });
    await restarted.service.restore();

    should(world.pane.typed.length).equal(1);
    should(log.some(event => event.type === 'surface.input_quarantined')).be.true();
    should(restarted.service.quarantinedUntil(SESSION, ['dev'])).be.a.Number();
    should(JSON.stringify(log)).not.containEql(scenario.value);
    restarted.advance(121 * 1000);
    should(restarted.service.quarantinedUntil(SESSION, ['dev'])).be.undefined();
  });

  it('should mask a vault secret that overlaps the typed value from the operator’s screen read, as one run', async () => {
    const vault = new SecretRedactor({
      values: async () => new Map([['TOKEN' as never, 'Tr0ub4dor&3-LEAKPROBE'.slice(5, 14)]]),
    } as unknown as SecretVault);
    const world = composed(scenario, { vault });
    await typedInto(world);
    const screen = await world.reader.snapshot(SESSION);

    should(screen).containEql('[redacted');
    for (const piece of piecesOf(scenario.value)) should(screen).not.containEql(piece);
    should(screen).not.containEql('4dor&3-L');
  });

  it('should drop a hyperlink payload carrying the value from the viewer’s frames', async () => {
    const world = composed(scenario);
    await typedInto(world);
    world.quarantine.end(SESSION, 'dev');
    world.pane.physical = [`${ESC}]8;;https://example.test/?code=${scenario.value}${ESC}\\go${ESC}]8;;${ESC}\\`];
    const result = await streamed(new RedactingTerminalStreamService(world.underlying, world.redactor));

    for (const piece of piecesOf(scenario.value)) should(result.frames).not.containEql(piece);
  });
});
