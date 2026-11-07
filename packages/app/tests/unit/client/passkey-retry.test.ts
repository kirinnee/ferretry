import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import { DaemonCallError, type TransportAnswer, type TransportRequest } from '../../../src/client/transport.ts';
import type { PairedDaemon } from '../../../src/daemons/daemon-list.ts';
import {
  type PasskeyHandler,
  type PasskeyNeed,
  type PasskeyRefusal,
  type PromptOrigin,
  requestOrigin,
} from '../../../src/passkey/passkey.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';

/**
 * THE CLIENT SEAM (G95, G105): a refusal for want of a passkey is shown to the handler, the handler's one prompt is
 * asked, and the call is sent again ONCE. Every plugin's call takes this path, so this is where it is pinned.
 */

const board = surface('board', { routes: ['GET /v1/board', 'POST /v1/board'] });
const compiled = [...CORE, board];

const DAEMON: PairedDaemon = {
  daemon: 'd1',
  machine: 'laptop',
  deviceId: 'device-1',
  address: 'http://127.0.0.1:40245',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
};

const UNLOCK = json({ error: 'Unlock this machine first.', code: 'unlock_required' }, 401);
const STEP_UP = json({ error: 'Confirm with a passkey.', code: 'grant_step_up_required' }, 403);
const FORBIDDEN = json({ error: 'Not granted.', code: 'grant_forbidden' }, 403);
const OK = json({ cards: [] });

/** A handler that reads the two codes and answers each prompt from a script, recording what it was asked. */
function handler(answers: readonly boolean[] = [true, true]) {
  const asked: { daemon: string; need: PasskeyNeed; origin: PromptOrigin }[] = [];
  let next = 0;
  const fake: PasskeyHandler = {
    need: (refusal: PasskeyRefusal) => {
      const code = (refusal.body as { code?: string } | null)?.code;
      if (refusal.status === 401 && code === 'unlock_required') return { kind: 'unlock' };
      if (refusal.status === 403 && code === 'grant_step_up_required') return { kind: 'step-up', act: 'change it' };
      return undefined;
    },
    confirm: async (daemon, need, origin) => {
      asked.push({ daemon: daemon.daemon, need, origin });
      const answer = answers[next] ?? false;
      next += 1;
      return answer;
    },
    ask: async () => false,
    focus: () => {},
    locked: () => [],
    subscribe: () => () => {},
  };
  return { fake, asked };
}

/** A daemon that answers the board route from a script, one answer per send. */
function daemon(script: readonly TransportAnswer[], passkey?: PasskeyHandler) {
  const board: TransportAnswer[] = [...script];
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(compiled));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return board.shift() ?? OK;
  });
  const client = new DaemonClient({
    transport,
    surfaces: compiled,
    ...(passkey === undefined ? {} : { passkey: { daemon: DAEMON, handler: passkey } }),
  });
  const sends = () => transport.requests.filter(request => request.path === '/v1/board');
  return { transport, client, sends };
}

describe('G105 one prompt, one retry', () => {
  test('G105 a step-up refusal asks the handler once and sends the same call again once', async () => {
    const { fake, asked } = handler([true]);
    const { client, sends } = daemon([STEP_UP, OK], fake);
    await client.start();
    const answer = await client.forPackage('board').call('POST /v1/board', { body: { title: 'x' } });
    expect(answer).toEqual({ cards: [] });
    expect(asked).toEqual([{ daemon: 'd1', need: { kind: 'step-up', act: 'change it' }, origin: 'explicit' }]);
    expect(sends().map(request => request.body)).toEqual([{ title: 'x' }, { title: 'x' }]);
  });

  test('G105 a second refusal after the retry is final: no second prompt, no third send', async () => {
    const { fake, asked } = handler([true, true]);
    const { client, sends } = daemon([STEP_UP, STEP_UP, OK], fake);
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('POST /v1/board')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonCallError);
    expect((failure as DaemonCallError).code).toBe('grant_step_up_required');
    expect(asked).toHaveLength(1);
    expect(sends()).toHaveLength(2);
  });

  test('G105 a dismissed prompt returns the refusal unchanged and sends nothing again', async () => {
    const { fake, asked } = handler([false]);
    const { client, sends } = daemon([STEP_UP, OK], fake);
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('POST /v1/board')
      .catch((error: unknown) => error);
    expect((failure as DaemonCallError).status).toBe(403);
    expect((failure as DaemonCallError).code).toBe('grant_step_up_required');
    expect(asked).toHaveLength(1);
    expect(sends()).toHaveLength(1);
  });

  test('G105 the unlock comes first, then the step-up for the act, each at most once', async () => {
    const { fake, asked } = handler([true, true]);
    const { client, sends } = daemon([UNLOCK, STEP_UP, OK], fake);
    await client.start();
    expect(await client.forPackage('board').call('POST /v1/board')).toEqual({ cards: [] });
    expect(asked.map(entry => entry.need.kind)).toEqual(['unlock', 'step-up']);
    expect(sends()).toHaveLength(3);
  });

  test('G105 a second unlock refusal is the answer, never a second unlock prompt', async () => {
    const { fake, asked } = handler([true, true]);
    const { client, sends } = daemon([UNLOCK, UNLOCK, OK], fake);
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('GET /v1/board')
      .catch((error: unknown) => error);
    expect((failure as DaemonCallError).code).toBe('unlock_required');
    expect(asked).toHaveLength(1);
    expect(sends()).toHaveLength(2);
  });

  test('G105 any other refusal raises no prompt (G108: not-granted asks nothing)', async () => {
    const { fake, asked } = handler([true]);
    const { client, sends } = daemon([FORBIDDEN, OK], fake);
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('POST /v1/board')
      .catch((error: unknown) => error);
    expect((failure as DaemonCallError).code).toBe('grant_forbidden');
    expect(asked).toHaveLength(0);
    expect(sends()).toHaveLength(1);
  });

  test('G105 with no handler, a passkey refusal is returned as it came', async () => {
    const { client, sends } = daemon([STEP_UP, OK]);
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('POST /v1/board')
      .catch((error: unknown) => error);
    expect((failure as DaemonCallError).code).toBe('grant_step_up_required');
    expect(sends()).toHaveLength(1);
  });

  test('G105 a handler that throws reads as no prompt, and the refusal stands', async () => {
    const { fake } = handler([true]);
    const broken: PasskeyHandler = {
      ...fake,
      confirm: async () => {
        throw new Error('no prompt here');
      },
    };
    const { client, sends } = daemon([STEP_UP, OK], broken);
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('POST /v1/board')
      .catch((error: unknown) => error);
    expect((failure as DaemonCallError).code).toBe('grant_step_up_required');
    expect(sends()).toHaveLength(1);
  });

  test('G105 the resend is the same request: its request id, query and body travel again', async () => {
    const { fake } = handler([true]);
    const { client, sends } = daemon([STEP_UP, OK], fake);
    await client.start();
    await client.forPackage('board').call('POST /v1/board', {
      body: { n: 1 },
      query: { q: 'a' },
      headers: { 'x-fy-request-id': 'req-1' },
    });
    const [first, second] = sends();
    expect(second).toEqual(first);
    expect(second?.headers).toEqual({ 'x-fy-request-id': 'req-1' });
  });

  test('G105 a package paused while the prompt was open is refused on the resend, never sent', async () => {
    let paused = false;
    const fake: PasskeyHandler = {
      ...handler().fake,
      confirm: async () => {
        paused = true;
        await client.refresh();
        return true;
      },
    };
    const transport = new FakeTransport((request: TransportRequest) => {
      if (request.path === '/v1/plugins') return json(inventoryOf(compiled, paused ? { board: { on: false } } : {}));
      if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
      return STEP_UP;
    });
    const client = new DaemonClient({ transport, surfaces: compiled, passkey: { daemon: DAEMON, handler: fake } });
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('POST /v1/board')
      .catch((error: unknown) => error);
    expect((failure as DaemonCallError).code).toBe('plugin_paused');
    expect(transport.requests.filter(request => request.path === '/v1/board')).toHaveLength(1);
  });
});

describe('G95 who started the request', () => {
  test('G95 a background GET is asked as background, so its prompt can wait for its machine', async () => {
    const { fake, asked } = handler([true]);
    const { client } = daemon([STEP_UP, OK], fake);
    await client.start();
    await client.forPackage('board').call('GET /v1/board');
    expect(asked[0]?.origin).toBe('background');
  });

  test('G95 anything a person pressed is explicit and asks at once', async () => {
    const { fake, asked } = handler([true]);
    const { client } = daemon([STEP_UP, OK], fake);
    await client.start();
    await client.forPackage('board').call('POST /v1/board');
    expect(asked[0]?.origin).toBe('explicit');
  });

  test('G95 GET and HEAD are reads; every other method is a press', () => {
    expect(['GET', 'get', 'HEAD'].map(requestOrigin)).toEqual(['background', 'background', 'background']);
    expect(['POST', 'PUT', 'PATCH', 'DELETE'].map(requestOrigin)).toEqual([
      'explicit',
      'explicit',
      'explicit',
      'explicit',
    ]);
  });
});
