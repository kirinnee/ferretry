import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ferretStanding } from '@ferretry/core-gate/contract/testing';
import {
  type FerretId,
  jsonResponse,
  type OutputGuard,
  type TargetKind,
  WITHHELD_SENTENCE,
} from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon, route } from '@ferretry/kernel/manifest';
import { ferret, owner, standInAdmission, type TestHost, testHost } from '@ferretry/kernel/testing';
import { InputHoldsPort, InputTargets, OutputGuardPort, RedactionPort, VaultPort } from '../../../contract/index.ts';
import { FakeInputTarget } from '../../../contract/testing/index.ts';
import vault from '../../../daemon/index.ts';
import { type InputRequest, padInputValue } from '../../../daemon/lib/inputs/wire.ts';

const FERRET = 'mvv6b4qw-49d0158d' as FerretId;
const VALUE = 'typed-through-the-real-input-service';
const TERMINAL = { kind: 'terminal' as TargetKind, key: 'dev' };
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function setup() {
  const target = new FakeInputTarget('terminal', 'dev');
  const built = Promise.withResolvers<void>();
  const send = Promise.withResolvers<void>();
  const fixture = definePlugin({
    id: 'input-test',
    title: 'Input test',
    version: '1.0.0',
    api: 5,
    core: false,
    kinds: [],
    hooks: { takes: [{ hook: InputTargets, key: 'terminal' }] },
    actions: {
      routes: [
        route('GET /v1/input-test/read', {
          minimum: 'operator',
          caller: 'any',
          guard: 'secrets',
          audit: { skip: 'a test read' },
        }),
      ],
    },
  });
  const terminals = implementDaemon(fixture, {
    build: () => ({
      hooks: { 'input.targets:terminal': target },
      routes: {
        'GET /v1/input-test/read': async () => {
          const response = jsonResponse({ text: 'the screen before typing' });
          built.resolve();
          await send.promise;
          return response;
        },
      },
    }),
  });
  let guard: OutputGuard;
  const admission = standInAdmission(() => owner());
  const host = await testHost({
    plugins: [vault, terminals],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    gate: {
      ...admission,
      admit: input =>
        input.table === 'tool'
          ? { outcome: 'admitted', actor: 'ferret', standing: ferretStanding(FERRET) }
          : admission.admit(input),
    },
    outputGuard: {
      stamp: targets => guard.stamp(targets),
      stillShowable: stamp => guard.stillShowable(stamp),
    },
  });
  hosts.push(host);
  guard = host.provided(OutputGuardPort);
  await host.runJob('inputs-restore');
  const api = host.provided(VaultPort);
  const raised = await api.raiseInput(FERRET, {
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'Password',
    sensitivity: 'secret',
    submit: 'agent',
  });
  if (!raised.ok) throw new Error(raised.error);
  const id = raised.value;
  const listed = await host.request('GET', `/v1/ferrets/${FERRET}/input-requests`);
  expect(listed.status).toBe(200);
  const [request] = listed.json<{ requests: InputRequest[] }>().requests;
  if (request === undefined) throw new Error('expected an input card');
  const deliver = async () =>
    await host.request('POST', `/v1/ferrets/${FERRET}/input-requests/${id}/deliver`, {
      body: {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest,
        padded: padInputValue(VALUE),
        submit: false,
      },
    });
  return { host, api, id, request, target, deliver, built, send, guard };
}

describe('the composed Vault input half', () => {
  test('I102 S20 a value typed through an input is masked in a Redaction read afterwards', async () => {
    const { host, api, id, target, deliver } = await setup();
    expect((await deliver()).status).toBe(200);
    expect(target.live.writes()).toBe(1);
    expect(await api.inputState(id)).toBe('delivered');
    const redaction = host.provided(RedactionPort);
    await redaction.read(async scope => {
      expect(scope.text(`before ${VALUE} after`)).toBe('before [redacted:input A1] after');
      const wrapped = [VALUE.slice(0, 10), VALUE.slice(10)];
      expect(scope.lines(wrapped)).toEqual(wrapped.map(line => '*'.repeat(line.length)));
      expect(scope.cells({ columns: 10, rows: wrapped.map(line => [...line]) }).rows.map(row => row.join(''))).toEqual(
        wrapped.map(line => '*'.repeat(line.length)),
      );
      await Promise.resolve();
      expect(scope.text(VALUE)).not.toContain(VALUE);
    });
    expect([...host.state('vault').files.values()].join('')).not.toContain(VALUE);
  });

  test('I74 a real input hold withholds an earlier guarded response; ending it allows a fresh read', async () => {
    const { host, deliver, built, send, guard } = await setup();
    const earlier = host.request('GET', '/v1/input-test/read');
    await built.promise;
    const stamp = guard.stamp([TERMINAL]);
    expect((await deliver()).status).toBe(200);
    expect(guard.stillShowable(stamp)).toBe(false);
    expect(host.provided(InputHoldsPort).decide(TERMINAL, 'read', 'ferret')).toEqual({ refused: 'quarantined' });
    send.resolve();
    const withheld = await earlier;
    expect(withheld.status).toBe(409);
    expect(withheld.body).toContain(WITHHELD_SENTENCE);
    const held = guard.stamp();
    expect((await host.request('POST', `/v1/ferrets/${FERRET}/input-quarantines/dev/end`)).status).toBe(200);
    expect(guard.stillShowable(held)).toBe(false);
    expect(host.provided(InputHoldsPort).decide(TERMINAL, 'read', 'ferret')).toBe('allow');
    expect((await host.request('GET', '/v1/input-test/read')).status).toBe(200);
  });

  test('the Vault facade keeps request ids separate from card ids and cancels only its own pending input', async () => {
    const { host, api, id, request } = await setup();
    expect(id).toBe(request.id);
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(await api.inputState(id)).toBe('pending');
    await expect(api.cancelInput('another-ferret' as FerretId, id)).rejects.toMatchObject({ code: 'not_found' });
    await api.cancelInput(FERRET, id);
    expect(await api.inputState(id)).toBe('cancelled');
    expect(
      await host.tool('input_wait', { id: request.agendaItemId, timeoutMs: 100 }, { as: ferret(FERRET) }),
    ).toMatchObject({ data: { state: 'cancelled' } });
  });
});
