/**
 * The agenda route's half of a card's gate (docs/board.md § Gates ask the owner): an answer to a gate item goes to
 * the gate items first, with who the board records the move as and whether this caller may move cards at all; their
 * refusals come back as the route's statuses. The gate items themselves are `tests/unit/board/gate-items.test.ts`.
 */
import { describe, it } from 'bun:test';
import type { GrantRefusal } from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import type { AgendaService } from '../../../../src/lib/agenda/index.ts';
import type { GateAnswer, GateAnswerOutcome } from '../../../../src/lib/board/index.ts';
import { agendaRoutes } from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agendaService, NO_HELD_REPLIES } from './support.ts';

/** The gate items as the route sees them: what each answer is told to come to, and what it was asked. */
class FakeGates {
  readonly asked: GateAnswer[] = [];
  permitted: (string | undefined)[] = [];

  constructor(private readonly outcome: (service: AgendaService) => Promise<GateAnswerOutcome>) {}

  service: AgendaService | undefined;
  /** Whether the item a dismissal names is a gate item. */
  gate = false;

  async isGate(): Promise<boolean> {
    return this.gate;
  }

  async answer(answer: GateAnswer): Promise<GateAnswerOutcome> {
    this.asked.push(answer);
    this.permitted.push(answer.permitted?.());
    return await this.outcome(this.service as AgendaService);
  }
}

interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  /** Absent: the boundary handed the route no standing to read. */
  readonly governance?: { readonly refusal?: GrantRefusal };
}

const HOST: Caller = { actor: 'admin-cli', credential: { kind: 'authenticated', tokenClass: 'admin' }, governance: {} };
const DEVICE: Caller = {
  actor: 'device:phone',
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'phone' },
  governance: {},
};
const FERRET: Caller = { actor: 'peer:s1', credential: { kind: 'authenticated', tokenClass: 'admin' }, governance: {} };

const post = async (gates: FakeGates, caller: Caller, body: unknown) => {
  const service = agendaService();
  gates.service = service;
  const governance: CallerGovernance | undefined =
    caller.governance === undefined
      ? undefined
      : {
          governed: caller.credential.tokenClass === 'device',
          decide: () => {
            const refusal = caller.governance?.refusal ?? 'granted';
            return { allowed: refusal === 'granted', refusal };
          },
        };
  const context: RouteContext = {
    request: request({
      method: 'POST',
      path: '/v1/sessions/s1/agenda',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: new Map([['sessionId', 's1']]),
    actor: caller.actor,
    credential: caller.credential,
    ...(governance === undefined ? {} : { governance }),
  };
  const route = agendaRoutes(
    service,
    { agendaDelivered: async () => 0, enrolledDevices: async () => 1 },
    NO_HELD_REPLIES,
    undefined,
    gates,
  ).find(each => each.method === 'POST' && each.path === '/v1/sessions/:sessionId/agenda');
  try {
    const response = await (route as NonNullable<typeof route>).handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
};

const answer = { action: 'resolve', id: 'A1', response: { kind: 'multiple-choice', choice: 'Done' }, note: 'works' };

describe('a gate answer on the agenda route', () => {
  it('hands the answer to the gate items with the owner at the machine recorded as the admin token', async () => {
    // Arrange
    const gates = new FakeGates(async service => ({
      handled: true,
      mutation: await service.dismiss('s1', 'A1', { kind: 'human' }),
    }));

    // Act
    await post(gates, HOST, answer);

    // Assert
    should(gates.asked[0]).match({
      sessionId: 's1',
      id: 'A1',
      response: { kind: 'multiple-choice', choice: 'Done' },
      note: 'works',
      actor: { kind: 'human' },
      caller: { kind: 'owner', via: 'admin-token' },
    });
    should(gates.permitted).eql([undefined]);
  });

  it('answers with the board the gate items left', async () => {
    // Arrange — the gate items answered it (here: on a board with nothing open)
    const gates = new FakeGates(async service => ({
      handled: true,
      mutation: await service.raise(
        's1',
        { source: 'agent-raised', sourceRef: null, kind: 'info', subject: 'Noted', why: 'w', howToResolve: 'h' },
        { kind: 'daemon', cause: 'system' },
      ),
    }));

    // Act
    const response = await post(gates, HOST, answer);

    // Assert
    should(response.status).equal(200);
    should(response.body).match({ sessionId: 's1', count: 1 });
  });

  it('records a paired device as the owner, and asks its fleet grant', async () => {
    // Arrange
    const granted = new FakeGates(async () => ({ handled: true, refused: { code: 'invalid', message: 'x' } }));
    const refused = new FakeGates(async () => ({ handled: true, refused: { code: 'invalid', message: 'x' } }));

    // Act
    await post(granted, DEVICE, answer);
    await post(refused, { ...DEVICE, governance: { refusal: 'not-granted' } }, answer);

    // Assert
    should(granted.asked[0]?.caller).eql({ kind: 'owner' });
    should(granted.permitted).eql([undefined]);
    should(refused.permitted).eql(['this device may not use the agent fleet, so it may not move a card']);
  });

  it('fails closed when the route was handed no standing to read', async () => {
    // Arrange
    const gates = new FakeGates(async () => ({ handled: false }));

    // Act
    await post(gates, { ...DEVICE, governance: undefined }, answer);

    // Assert
    should(gates.permitted[0]).startWith('this daemon could not check whether this caller may move cards');
  });

  it('never names a ferret the owner, and asks no grant of it', async () => {
    // Arrange
    const gates = new FakeGates(async () => ({
      handled: true,
      refused: { code: 'forbidden', message: 'only the owner answers A1' },
    }));

    // Act
    const response = await post(gates, FERRET, answer);

    // Assert
    should(gates.asked[0]?.actor).match({ kind: 'agent', sessionId: 's1' });
    should(gates.asked[0]?.caller).eql({ kind: 'daemon' });
    should(gates.permitted).eql([undefined]);
    should(response).eql({ status: 403, body: { error: 'only the owner answers A1', code: 'forbidden' } });
  });

  it('turns each refusal into its status, and leaves any other item to the ordinary answer', async () => {
    // Arrange
    const cases = [
      ['invalid', 400, 'invalid'],
      ['moved-on', 409, 'gate_moved_on'],
      ['not-moved', 409, 'gate_not_moved'],
    ] as const;

    // Act + Assert
    for (const [code, status, wire] of cases) {
      const gates = new FakeGates(async () => ({ handled: true, refused: { code, message: code } }));
      should(await post(gates, HOST, answer)).eql({ status, body: { error: code, code: wire } });
    }
    const ordinary = await post(new FakeGates(async () => ({ handled: false })), HOST, answer);
    should(ordinary).match({ status: 404, body: { code: 'not-found' } });
  });

  it('is not asked about anything but an answer', async () => {
    // Arrange
    const gates = new FakeGates(async () => ({ handled: false }));

    // Act
    await post(gates, HOST, { action: 'resolve', id: 'A1' });
    await post(gates, HOST, { action: 'dismiss', id: 'A1' });

    // Assert
    should(gates.asked).be.empty();
  });
});

describe('Not needed on a gate item over the agenda route', () => {
  const dismiss = { action: 'dismiss', id: 'A1' };

  it('asks a device the same fleet grant an answer does', async () => {
    // Arrange
    const gates = new FakeGates(async () => ({ handled: false }));
    gates.gate = true;

    // Act
    const refused = await post(gates, { ...DEVICE, governance: { refusal: 'not-granted' } }, dismiss);
    const granted = await post(gates, DEVICE, dismiss);
    const closed = await post(gates, { ...DEVICE, governance: undefined }, dismiss);

    // Assert
    should(refused).match({
      status: 403,
      body: { error: 'this device may not use the agent fleet, so it may not move a card' },
    });
    should(granted.status).equal(404);
    should(closed.status).equal(403);
  });

  it('asks nothing of an item that is not a gate, nor of a ferret (the agenda refuses it)', async () => {
    // Arrange
    const plain = new FakeGates(async () => ({ handled: false }));
    const gate = new FakeGates(async () => ({ handled: false }));
    gate.gate = true;

    // Act
    const device = await post(plain, { ...DEVICE, governance: { refusal: 'not-granted' } }, dismiss);
    const ferret = await post(gate, { ...FERRET, governance: { refusal: 'not-granted' } }, dismiss);

    // Assert
    should(device.status).equal(404);
    should(ferret.status).equal(404);
  });
});
