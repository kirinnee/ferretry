import { describe, expect, it } from 'bun:test';
import type { CliContext, PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import { inputVerbs } from '../../../cli/lib/input/commands.ts';
import { InputController, INPUT_OWNER_REFUSAL } from '../../../cli/lib/input/controller.ts';
import { RouteInputGateway } from '../../../cli/lib/input/gateway.ts';
import type { InputGateway, InputPorts } from '../../../cli/lib/input/ports.ts';
import type { InputDeliverAnswer, InputDeliverBodyView, InputRequestView } from '../../../cli/lib/input/wire.ts';
import manifest from '../../../manifest.ts';
import { ExitStatus } from '../../../cli/shell.ts';

/**
 * `fy input ls|answer|cancel` (v4 parity, docs/agent-tools.md): the owner answers a ferret's input card at the machine.
 * Fixtures only: the value in this file is an obvious fake, and the leak sweep proves it never reaches an output.
 */
const SESSION = 'ms8kkfyd-95b7037e';
const REQUEST_ID = 'b'.repeat(32);
const DIGEST = 'c'.repeat(64);
const VALUE = 'hunter2-UNIQUE';
const AT = '2026-10-30T09:00:00.000Z';

const request = (overrides: Record<string, unknown> = {}): InputRequestView =>
  ({
    id: REQUEST_ID,
    sessionId: SESSION,
    agendaItemId: 'A7',
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'sudo password to install the package',
    sensitivity: 'secret',
    fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }],
    submit: 'offer-owner',
    raisedAt: AT,
    expiresAt: '2026-10-30T09:10:00.000Z',
    observed: {
      kind: 'terminal',
      paneProof: { paneId: '%3', pid: 1234 },
      foreground: { pid: 4321, pgid: 4321, comm: 'sudo', argv: 'sudo apt install jq' },
      echo: 'off',
      cursorRow: 4,
      promptLine: '[sudo] password for deploy:',
      promptLineDigest: DIGEST,
      program: 'sudo',
      recognisedConsumer: true,
    },
    observedDigest: DIGEST,
    state: 'pending',
    ...overrides,
  }) as unknown as InputRequestView;

class FakeGateway implements InputGateway {
  readonly delivered: { sessionId: string; requestId: string; body: InputDeliverBodyView }[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly requests: readonly InputRequestView[] = [request()]) {}
  async list() {
    return { requests: [...this.requests] };
  }
  async deliver(sessionId: string, requestId: string, body: InputDeliverBodyView): Promise<InputDeliverAnswer> {
    this.delivered.push({ sessionId, requestId, body });
    return { id: REQUEST_ID, state: 'delivered', submitted: body.submit } as InputDeliverAnswer;
  }
  async cancel(_sessionId: string, requestId: string) {
    this.cancelled.push(requestId);
    return request({ state: 'cancelled' });
  }
}

function rig(overrides: Partial<InputPorts> = {}, gateway = new FakeGateway()) {
  const messages: string[] = [];
  const diagnostics: string[] = [];
  const asked: string[] = [];
  const errs: string[] = [];
  const ports: InputPorts = {
    gateway,
    out: { success: m => messages.push(m), diagnostic: m => diagnostics.push(m) },
    prompt: {
      askHidden: async message => {
        asked.push(message);
        return VALUE;
      },
    },
    interactive: true,
    ownSessionId: undefined,
    now: () => Date.parse('2026-10-30T09:02:00.000Z'),
    newDeliveryId: () => '7b0a5f1c-3a49-4a7e-9d69-2f2a7f6c2e11',
    ...overrides,
  };
  const exit = new ExitStatus();
  const controller = new InputController(ports);
  const verbs = inputVerbs(controller, { err: m => errs.push(m) }, exit);
  const everything = () => [...messages, ...diagnostics, ...errs].join('\n');
  return { gateway, controller, verbs, messages, diagnostics, asked, errs, everything };
}

describe('fy input ls', () => {
  it('V-0289 lists what is waiting, one request a block, with no value in it', async () => {
    const r = rig();
    expect(await r.verbs['input ls']({ args: [], options: { session: SESSION } })).toBe(0);
    expect(r.messages.join('\n')).toContain('!A7  pending  secret  %terminal:dev  8m left');
    expect(r.messages.join('\n')).toContain('the ferret says: sudo password to install the package');
  });

  it('says so when nothing is waiting, and names the account the daemon matched', async () => {
    const none = rig({}, new FakeGateway([]));
    await none.verbs['input ls']({ args: [], options: { s: SESSION } });
    expect(none.messages).toEqual(['No input requests are waiting.']);
    const matched = rig(
      {},
      new FakeGateway([request({ saved: { offers: [{ id: 'GITHUB', label: 'GitHub', matched: true }] } })]),
    );
    await matched.verbs['input ls']({ args: [], options: { session: SESSION } });
    expect(matched.messages.join('\n')).toContain('use: GITHUB (GitHub)');
  });

  it('refuses without a session: an input request belongs to one session', async () => {
    const r = rig();
    expect(await r.verbs['input ls']({ args: [], options: {} })).toBe(1);
    expect(r.errs.join('')).toContain('name the session with --session <id>');
  });

  it('prints the payload for --json', async () => {
    const r = rig();
    await r.verbs['input ls']({ args: [], options: { session: SESSION, json: true } });
    expect(JSON.parse(r.messages[0] ?? '{}')).toHaveProperty('requests');
  });
});

describe('fy input answer', () => {
  it('V-0287 shows what the daemon sees, reads the value hidden, pads it and types it with Enter in a terminal', async () => {
    const r = rig();
    expect(await r.verbs['input answer']({ args: ['!A7'], options: { session: SESSION } })).toBe(0);
    expect(r.diagnostics.join('\n')).toContain('!A7 wants a secret value typed into %terminal:dev');
    expect(r.diagnostics.join('\n')).toContain('reading the terminal now: sudo');
    const [sent] = r.gateway.delivered;
    expect(sent?.body.padded).toMatch(/^00014:hunter2-UNIQUE {10}/u);
    expect(sent?.body).toMatchObject({ submit: true, observedDigest: DIGEST });
    expect(r.messages).toEqual(['Sent to %terminal:dev and pressed Enter.']);
    expect(r.everything()).not.toContain(VALUE);
  });

  it('leaves a page field unsubmitted unless --enter, and never presses Enter with --no-enter', async () => {
    const page = request({ target: { kind: 'page', key: 'app' } });
    const plain = rig({}, new FakeGateway([page]));
    await plain.verbs['input answer']({ args: ['A7'], options: { session: SESSION } });
    expect(plain.gateway.delivered[0]?.body.submit).toBe(false);
    const enter = rig({}, new FakeGateway([page]));
    await enter.verbs['input answer']({ args: ['A7'], options: { session: SESSION, enter: true } });
    expect(enter.gateway.delivered[0]?.body.submit).toBe(true);
    const none = rig();
    await none.verbs['input answer']({ args: ['A7'], options: { session: SESSION, enter: false } });
    expect(none.gateway.delivered[0]?.body.submit).toBe(false);
  });

  it('types a named account instead of reading a value: only its NAME is sent', async () => {
    const r = rig({ interactive: false });
    expect(await r.verbs['input answer']({ args: ['!A7'], options: { session: SESSION, account: 'GITHUB' } })).toBe(0);
    expect(r.asked).toEqual([]);
    expect(r.gateway.delivered[0]?.body).toMatchObject({ entry: 'GITHUB' });
    expect(r.gateway.delivered[0]?.body.padded).toBeUndefined();
  });

  it('refuses a value in a pipe, a bad handle, and --save-as with --account, sending nothing', async () => {
    const piped = rig({ interactive: false });
    expect(await piped.verbs['input answer']({ args: ['A7'], options: { session: SESSION } })).toBe(1);
    expect(piped.errs.join('')).toContain('needs a terminal you are sitting at');
    const bad = rig();
    expect(await bad.verbs['input answer']({ args: ['A7'], options: { session: SESSION, account: 'github' } })).toBe(1);
    expect(bad.errs.join('')).toContain("is not an account's handle");
    const both = rig();
    expect(
      await both.verbs['input answer']({
        args: ['A7'],
        options: { session: SESSION, account: 'GITHUB', 'save-as': 'X' },
      }),
    ).toBe(1);
    expect(both.errs.join('')).toContain('cannot be combined with --account');
    for (const each of [piped, bad, both]) expect(each.gateway.delivered).toEqual([]);
  });

  it('keeps the typed value as an account with --save-as, only when the card can be saved, and says what came of it', async () => {
    const saved = { saves: 'password', suggest: { id: 'VERCEL', label: 'Vercel' }, offers: [] };
    const r = rig({}, new FakeGateway([request({ saved })]));
    await r.verbs['input answer']({ args: ['A7'], options: { session: SESSION, 'save-as': 'VERCEL' } });
    expect(r.gateway.delivered[0]?.body.save).toEqual({ entry: 'VERCEL', label: 'Vercel' });
    const unsaveable = rig();
    expect(
      await unsaveable.verbs['input answer']({ args: ['A7'], options: { session: SESSION, 'save-as': 'X' } }),
    ).toBe(1);
    expect(unsaveable.errs.join('')).toContain('cannot be saved');
    const short = rig({ prompt: { askHidden: async () => 'abc' } }, new FakeGateway([request({ saved })]));
    expect(
      await short.verbs['input answer']({ args: ['A7'], options: { session: SESSION, 'save-as': 'VERCEL' } }),
    ).toBe(1);
    expect(short.gateway.delivered).toEqual([]);
  });

  it('allows a paste with nothing to type, and refuses an account or a save for one', async () => {
    const paste = request({ source: { name: 'vercel', from: { kind: 'command', program: 'gh' } } });
    const r = rig({ interactive: false }, new FakeGateway([paste]));
    await r.verbs['input answer']({ args: ['A7'], options: { session: SESSION } });
    expect(r.gateway.delivered[0]?.body).toMatchObject({ sealed: true });
    expect(r.diagnostics.join('\n')).toContain(
      'pastes the secure copy sealed:vercel, captured from gh: nothing to type',
    );
    expect(r.messages).toEqual(['Pasted into %terminal:dev and pressed Enter.']);
    const refused = rig({}, new FakeGateway([paste]));
    expect(
      await refused.verbs['input answer']({ args: ['A7'], options: { session: SESSION, account: 'GITHUB' } }),
    ).toBe(1);
    expect(refused.errs.join('')).toContain('pastes a secure copy');
  });

  it('asks each field of a card of several, hidden, and sends them together', async () => {
    const two = request({
      fields: [
        { id: 'user', label: 'Email', sensitivity: 'plain' },
        { id: 'pass', label: 'Password', sensitivity: 'secret' },
      ],
    });
    const r = rig({}, new FakeGateway([two]));
    await r.verbs['input answer']({ args: ['A7'], options: { session: SESSION } });
    expect(r.asked).toHaveLength(2);
    expect(r.gateway.delivered[0]?.body.fields?.map(field => field.field)).toEqual(['user', 'pass']);
    expect(r.everything()).not.toContain(VALUE);
  });

  it('says why when a request is not pending, still being re-checked, or unknown, and sends nothing', async () => {
    const done = rig({}, new FakeGateway([request({ state: 'delivered' })]));
    expect(await done.verbs['input answer']({ args: ['A7'], options: { session: SESSION } })).toBe(1);
    expect(done.errs.join('')).toContain('is delivered, not waiting for a value');
    const rechecking = rig({}, new FakeGateway([request({ observed: undefined })]));
    await rechecking.verbs['input answer']({ args: ['A7'], options: { session: SESSION } });
    expect(rechecking.errs.join('')).toContain('still being re-checked');
    const unknown = rig();
    await unknown.verbs['input answer']({ args: ['A9'], options: { session: SESSION } });
    expect(unknown.errs.join('')).toContain('no input request !A9');
    await unknown.verbs['input answer']({ args: ['nonsense'], options: { session: SESSION } });
    expect(unknown.errs.join('')).toContain('is not an agenda reference');
    for (const each of [done, rechecking, unknown]) expect(each.gateway.delivered).toEqual([]);
  });

  it('says a refused delivery in words, with the reason', async () => {
    const gateway = new FakeGateway();
    gateway.deliver = async () =>
      ({ id: REQUEST_ID, state: 'refused', submitted: false, reason: 'target_changed' }) as InputDeliverAnswer;
    const r = rig({}, gateway);
    await r.verbs['input answer']({ args: ['A7'], options: { session: SESSION } });
    expect(r.messages).toEqual(['Not sent: the target is no longer the one the card showed.']);
  });
});

describe('fy input cancel', () => {
  it('V-0288 declines the request', async () => {
    const r = rig();
    expect(await r.verbs['input cancel']({ args: ['!A7'], options: { session: SESSION } })).toBe(0);
    expect(r.gateway.cancelled).toEqual([REQUEST_ID]);
    expect(r.messages).toEqual(['Declined !A7.']);
  });
});

describe('the owner’s command, in the CLI too', () => {
  it('is refused inside a ferret’s pane before the daemon is asked', async () => {
    for (const caller of [{ ownSessionId: SESSION }]) {
      const r = rig(caller);
      for (const [verb, args] of [
        ['input ls', []],
        ['input answer', ['A7']],
        ['input cancel', ['A7']],
      ] as const) {
        expect(await r.verbs[verb]({ args, options: { session: SESSION } })).toBe(1);
      }
      expect(r.errs.join('')).toContain(INPUT_OWNER_REFUSAL);
      expect(r.gateway.delivered).toEqual([]);
    }
  });
});

describe('the verbs read their words as commander did', () => {
  it('has no flag that carries a value, and refuses an unknown one without printing it back', async () => {
    const r = rig();
    expect(await r.verbs['input answer']({ args: ['A7'], options: { session: SESSION, value: VALUE } })).toBe(1);
    expect(r.errs.join('')).toContain("unknown option '--value'");
    expect(r.everything()).not.toContain(VALUE);
    expect(await r.verbs['input ls']({ args: ['extra'], options: { session: SESSION } })).toBe(1);
    expect(r.errs.join('')).toContain("too many arguments for 'ls'");
  });
});

describe('the gateway and the real half', () => {
  it('speaks the manifest’s own route keys with the ferret in the path, and the deliver body as given', async () => {
    const calls: { route: string; init: unknown }[] = [];
    const client = {
      call: async (route: string, init?: unknown) => {
        calls.push({ route, init });
        if (route.startsWith('GET')) return { requests: [request()] };
        if (route.endsWith('/deliver')) return { id: REQUEST_ID, state: 'delivered', submitted: true };
        return request({ state: 'cancelled' });
      },
    } as unknown as PluginClient;
    const gateway = new RouteInputGateway(client);
    await gateway.list(SESSION);
    await gateway.deliver(SESSION, REQUEST_ID, {
      deliveryId: 'd',
      observedDigest: DIGEST,
      sealed: true,
      submit: false,
    });
    await gateway.cancel(SESSION, REQUEST_ID);
    const keys = new Set<string>(manifest.actions.routes.map(route => route.key));
    for (const call of calls) expect(keys.has(call.route)).toBe(true);
    expect(calls.map(call => (call.init as { params: unknown }).params)).toEqual([
      { ferretId: SESSION },
      { ferretId: SESSION, requestId: REQUEST_ID },
      { ferretId: SESSION, requestId: REQUEST_ID },
    ]);
  });

  it('V-0286 answers every verb the manifest declares for input', () => {
    const io: TerminalIo = { out: () => undefined, err: () => undefined, isTty: false };
    const ctx = { manifest, client: { call: async () => undefined }, io } as unknown as CliContext<typeof manifest>;
    const half = cli.build?.(ctx);
    for (const verb of ['input ls', 'input answer', 'input cancel'] as const) {
      expect(manifest.actions.cli.map(entry => entry.verb)).toContain(verb);
      expect(half?.verbs[verb]).toBeFunction();
    }
  });
});
