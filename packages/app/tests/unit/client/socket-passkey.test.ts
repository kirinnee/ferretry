import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import type { SocketListeners, TransportAnswer } from '../../../src/client/transport.ts';
import type { PasskeyHandler } from '../../../src/passkey/passkey.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';
import {
  cap,
  decideCapability,
  DEFAULT_GATE_CONFIG,
  DEFAULT_GATE_SECURITY,
} from '../../../../core/gate/contract/index.ts';
import { FakeStepUpWitness } from '../../../../core/gate/contract/testing/index.ts';

const browser = surface('browsers', { sockets: ['GET /v1/browser/stream'], routes: ['POST /v1/browser'] });
const surfaces = [...CORE, browser];
const refused = json({ code: 'grant_step_up_required', demand: { capability: 'browser', axis: 'use' } }, 403);
const tick = async () => {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
};

async function fixture(first: TransportAnswer = refused, accepted = true, waiting?: Promise<void>) {
  const settings = { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true, stepUpWindowMinutes: 0 };
  const stepUps = new FakeStepUpWitness({ nowMs: () => 1_000, settings: () => settings });
  const subject = { deviceId: 'phone', appSession: 's-phone' };
  const prompts: string[] = [];
  const transport = new FakeTransport(request =>
    request.path === '/v1/plugins' ? json(inventoryOf(surfaces)) : json({ protocol: 1, version: '5.0.0' }),
  );
  transport.socket = (path, listeners) => {
    const record = { path, listeners, closed: false };
    transport.sockets.push(record);
    queueMicrotask(() => {
      if (record.closed) return;
      // The production grant rule and conformance-tested witness enforce the real zero-minute policy.
      const decision = decideCapability(cap('browser', 'use'), {
        grants: DEFAULT_GATE_CONFIG.grants,
        governed: true,
        hostLocal: false,
        stepUp: stepUps.held(subject),
        useAsksStepUp: true,
      });
      if (decision.allowed) {
        if (decision.steppedUp) stepUps.spend(subject);
        listeners.onOpen?.();
      } else listeners.onClose('the daemon refused this stream: 403', undefined, first);
    });
    return {
      send: () => {},
      close: () => {
        record.closed = true;
      },
    };
  };
  const handler: PasskeyHandler = {
    need: answer =>
      (answer.body as { code?: string })?.code === 'grant_step_up_required'
        ? { kind: 'step-up', act: 'browser.use' }
        : undefined,
    confirm: async (_daemon, _need, origin) => {
      prompts.push(origin);
      await waiting;
      if (accepted) stepUps.grant(subject);
      return accepted;
    },
    ask: async () => false,
    focus: () => {},
    locked: () => [],
    subscribe: () => () => {},
  };
  const client = new DaemonClient({
    transport,
    surfaces,
    passkey: {
      daemon: {
        daemon: 'fake',
        machine: 'fake',
        deviceId: 'fake',
        address: 'http://fake.invalid',
        carriers: [],
        pairedAt: 1,
        lastSelectedAt: 1,
      },
      handler,
    },
  });
  await client.start();
  const end: unknown[] = [];
  let opened = 0;
  const listeners = (confirm?: true): SocketListeners => ({
    confirm,
    onFrame: () => {},
    onOpen: () => {
      ++opened;
    },
    onClose: (...args) => end.push(args),
  });
  return {
    transport,
    client,
    prompts,
    end,
    opened: () => opened,
    listeners,
    proofs: () => (stepUps.held(subject) ? 1 : 0),
  };
}

describe('D-87 passkey on the actual stream', () => {
  test('a background client cannot ask a passkey even when its socket requests confirmation', async () => {
    const f = await fixture();
    f.client.forPackage('browsers', { origin: 'background' }).socket('GET /v1/browser/stream', {}, f.listeners(true));
    await tick();
    expect(f.prompts).toEqual([]);
    expect(f.transport.sockets).toHaveLength(1);
    expect(f.end).toHaveLength(1);
    f.client.stop();
  });

  test('leaving during the ceremony cannot open a late stream for the previous pane', async () => {
    let finish = () => {};
    const waiting = new Promise<void>(resolve => {
      finish = resolve;
    });
    const f = await fixture(refused, true, waiting);
    const socket = f.client.forPackage('browsers').socket('GET /v1/browser/stream', {}, f.listeners(true));
    await tick();
    expect(f.prompts).toEqual(['explicit']);
    socket.close();
    finish();
    await tick();
    expect(f.transport.sockets).toHaveLength(1);
    expect(f.opened()).toBe(0);
    expect(f.end).toEqual([]);
    f.client.stop();
  });

  test('a zero-minute single-use proof admits the pressed stream, with no preceding start or status', async () => {
    const f = await fixture();
    const socket = f.client.forPackage('browsers').socket('GET /v1/browser/stream', {}, f.listeners(true));
    await tick();
    expect(f.prompts).toEqual(['explicit']);
    expect(f.opened()).toBe(1);
    expect(f.proofs()).toBe(0);
    expect(f.transport.sockets).toHaveLength(2);
    expect(f.transport.requests.filter(request => request.path.startsWith('/v1/browser'))).toEqual([]);
    expect(f.end).toEqual([]);
    socket.close();
    f.client.stop();
  });

  test('an unpressed stream stays quiet and preserves its typed refusal', async () => {
    const f = await fixture();
    f.client.forPackage('browsers').socket('GET /v1/browser/stream', {}, f.listeners());
    await tick();
    expect(f.prompts).toEqual([]);
    expect(f.end).toHaveLength(1);
    expect(f.end[0]).toMatchObject([
      'the daemon refused this stream: 403',
      undefined,
      {
        status: 403,
        body: { code: 'grant_step_up_required', demand: { capability: 'browser', axis: 'use' } },
      },
    ]);
    f.client.stop();
  });

  test('cancel and hard denial end the attempt without looping or prompting again', async () => {
    for (const [answer, accept, count] of [
      [refused, false, 1],
      [json({ code: 'grant_forbidden' }, 403), true, 0],
    ] as const) {
      const f = await fixture(answer, accept);
      f.client.forPackage('browsers').socket('GET /v1/browser/stream', {}, f.listeners(true));
      await tick();
      expect(f.prompts).toHaveLength(count);
      expect(f.opened()).toBe(0);
      expect(f.transport.sockets).toHaveLength(1);
      expect(f.end).toHaveLength(1);
      f.client.stop();
    }
  });
});
