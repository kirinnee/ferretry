import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { type AsksApi, AsksPort } from '../../../../asks/contract/index.ts';
import { Harnesses, Runners, type FerretId } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import {
  deviceStanding,
  FakeGate,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
} from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * Audit A fix 7 (and fix 8: a hidden item answers exactly like an absent id): the per-ferret Asks board reads are open to any ferret (`caller: any`, v4 parity), and a Warden notice
 * keeps the investigator's reason, context and remedy on the board it was raised on. A FERRET reads a Warden-sourced item
 * of its own lineage as fixed sentences, and one about another lineage not at all (the item, its versions, one version,
 * its conversation); the board's count and order show no gap. The owner and a paired device read everything, as before,
 * and an item the Warden did not raise is unchanged for everyone.
 *
 * The REAL Ferrets, Asks and Warden halves run behind the stand-in admission (the kernel cannot import Gate's daemon,
 * `context-imports`): the caller's standing is the stand-in's `ferretStanding` / `ownerStanding` / `deviceStanding`, the same
 * `credential.tokenClass` the production Gate admits a ferret bearer, the admin token and an enrolled device with. The REAL
 * `GateAdmission` over the shipped Asks read descriptors is `core/gate/tests/unit/daemon/asks-routes-caller.test.ts`. The
 * Warden's notice is a REAL `AsksPort.notify` bound as the Warden. Fixture values only: no model, no spend.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const SECRET_WHY = 'FIXTURE investigator says the stranger spent $987.654';
const SECRET_CONTEXT = 'FIXTURE investigator context naming the stranger';
const SECRET_REMEDY = 'FIXTURE investigator remedy: stop the stranger';
const HIDDEN = [SECRET_WHY, SECRET_CONTEXT, SECRET_REMEDY, '987.654', 'FIXTURE investigator'];
const FIXED_WHY = 'The Warden asked the owner to look at this. The Warden’s reasons are the owner’s to read.';

const CALLER_HEADER = 'x-test-caller';
const PERSON_HEADER = 'x-test-person';

const world = async () => {
  const host = await testHost({
    plugins: [
      real('asks'),
      real('ferrets'),
      real('warden'),
      real('packs'),
      real('agenda'),
      implementDaemon(
        definePlugin({
          id: 'claude-code',
          title: 'Claude Code (fake)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
        }),
        { build: () => ({ hooks: { 'harnesses:claude-code': new FakeHarness() } }) },
      ),
      implementDaemon(
        definePlugin({
          id: 'terminals',
          title: 'Terminals (fake)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
        }),
        { build: () => ({ hooks: { 'runners:tmux': new FakeRunner() } }) },
      ),
    ],
    gate: new StandInAdmission(request => {
      const caller = request.headers.get(CALLER_HEADER);
      if (caller !== null) return ferretStanding(caller as FerretId);
      return request.headers.get(PERSON_HEADER) === null ? ownerStanding() : deviceStanding('phone');
    }),
    fakes: {
      gate: new FakeGate(),
      vault: new FakeVault(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
    },
  });
  const asks = host.provided(AsksPort, 'warden') as AsksApi;
  const begin = async (parent?: string): Promise<string> => {
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: '/work/project', ...(parent === undefined ? {} : { parent }) },
    });
    expect([started.status, JSON.stringify(started.json())]).toEqual([201, expect.anything()]);
    const { id } = started.json<{ id: string }>();
    const stopped = await host.request('POST', `/v1/ferrets/${id}/stop`);
    expect(stopped.status).toBe(200);
    return id;
  };
  // lead -> helper is one lineage; the stranger is another.
  const lead = await begin();
  const helper = await begin(lead);
  const stranger = await begin();
  const get = async (who: 'ferret' | 'owner' | 'device', path: string) =>
    await host.request('GET', path, {
      ...(who === 'ferret'
        ? { headers: { [CALLER_HEADER]: lead } }
        : who === 'device'
          ? { headers: { [PERSON_HEADER]: 'phone' } }
          : {}),
    });
  /** The Warden's notice about `ferret`, with the investigator's words in it. */
  const warden = async (ferret: string, kind = 'sus_thinking') =>
    await asks.notify({
      source: 'daemon' as never,
      entry: `f.${ferret}.warden:ask:${kind}` as never,
      ref: { ferret, kind },
      subject: `Warden flag for ${ferret}`,
      why: SECRET_WHY,
      context: SECRET_CONTEXT,
      howToResolve: SECRET_REMEDY,
      raisedBy: { kind: 'daemon' },
      ferret,
    });
  /**
   * An ask the Warden did not raise: the ferret's own, added on its own board. (A daemon item whose shape nobody listed is
   * the Warden's to a ferret reader since fix 8, so a plain daemon note no longer stands for "not the Warden's".)
   */
  const plain = async (ferret: string, entry: string) => {
    const added = await host.request('POST', `/v1/ferrets/${ferret}/agenda`, {
      headers: { [CALLER_HEADER]: ferret },
      body: {
        action: 'add',
        subject: `Plain note ${entry}`,
        why: 'A plain reason',
        howToResolve: 'A plain remedy',
        premise: 'A plain premise',
        context: 'A plain context',
        ask: { kind: 'open-question' },
      },
    });
    expect([added.status, added.body]).toEqual([200, expect.anything()]);
  };
  return { host, lead, helper, stranger, get, warden, plain };
};

const ROUTES = ['', '/versions', '/versions/1', '/conversation'] as const;

test('audit A fix 7 a ferret reads its own lineage’s Warden notice as fixed sentences, on every read route', async () => {
  const w = await world();
  try {
    // A helper's notice stands on its lead's board (the home rule), so the lead's board holds both.
    await w.warden(w.lead);
    await w.warden(w.helper, 'sus_subprocess');
    const board = await w.get('ferret', `/v1/ferrets/${w.lead}/agenda`);
    expect(board.status).toBe(200);
    const items = board.json<{ items: { id: string; subject: string; why: string; howToResolve: string }[] }>().items;
    expect(items.length).toBeGreaterThan(0);
    for (const entry of items) expect(entry.why).toBe(FIXED_WHY);
    const [item] = items;
    for (const suffix of ROUTES) {
      const read = await w.get('ferret', `/v1/ferrets/${w.lead}/agenda/${item?.id}${suffix}`);
      expect(read.status).toBe(200);
      for (const hidden of HIDDEN) expect(read.body).not.toContain(hidden);
    }
    for (const hidden of HIDDEN) expect(board.body).not.toContain(hidden);
    expect(board.body).not.toContain('warden:ask');
    expect(board.body).toContain('"sourceRef":null');
  } finally {
    await w.host.stop();
  }
});

test('audit A fix 7 a ferret sees no Warden item of another lineage: not the board, the item, its versions or its conversation', async () => {
  const w = await world();
  try {
    await w.plain(w.stranger, 'plain-1');
    await w.warden(w.stranger);
    await w.plain(w.stranger, 'plain-2');
    // The owner sees all three, in order.
    const owner = await w.get('owner', `/v1/ferrets/${w.stranger}/agenda`);
    const all = owner.json<{ count: number; items: { id: string; subject: string }[] }>();
    expect(all.count).toBe(3);
    const hidden = all.items[1];
    expect(hidden?.subject).toContain('Warden flag');
    // The ferret sees the two plain items, in the same order, as a board of two.
    const board = await w.get('ferret', `/v1/ferrets/${w.stranger}/agenda`);
    expect(board.status).toBe(200);
    const seen = board.json<{ count: number; items: { id: string; subject: string }[] }>();
    expect(seen.count).toBe(2);
    expect(seen.items.map(item => item.id)).toEqual([all.items[0]?.id ?? '', all.items[2]?.id ?? '']);
    expect(seen.items.map(item => item.subject)).toEqual(['Plain note plain-1', 'Plain note plain-2']);
    for (const text of HIDDEN) expect(board.body).not.toContain(text);
    expect(board.body).not.toContain(w.stranger.length > 0 && hidden !== undefined ? `"id":"${hidden.id}"` : 'x-none');
    // Every route for the hidden item reads exactly as an id that was never raised: the same status and bytes.
    const absentId = 'A99';
    for (const suffix of [...ROUTES, '/versions/9', '/conversation?version=1']) {
      const read = await w.get('ferret', `/v1/ferrets/${w.stranger}/agenda/${hidden?.id}${suffix}`);
      const absent = await w.get('ferret', `/v1/ferrets/${w.stranger}/agenda/${absentId}${suffix}`);
      expect([suffix, read.status, read.body.replaceAll(hidden?.id ?? '', '<ID>')]).toEqual([
        suffix,
        absent.status,
        absent.body.replaceAll(absentId, '<ID>'),
      ]);
      expect(read.status === 200 || read.status === 404).toBe(true);
      for (const text of HIDDEN) expect(read.body).not.toContain(text);
    }
    // A plain item of the same board is unchanged for the ferret: the same bytes the owner reads.
    const plainId = all.items[0]?.id;
    const ferretPlain = await w.get('ferret', `/v1/ferrets/${w.stranger}/agenda/${plainId}`);
    const ownerPlain = await w.get('owner', `/v1/ferrets/${w.stranger}/agenda/${plainId}`);
    expect(ferretPlain.status).toBe(200);
    expect(ferretPlain.body).toBe(ownerPlain.body);
  } finally {
    await w.host.stop();
  }
});

test('audit A fix 7 control: the owner and a device read the Warden notice whole, on every route', async () => {
  const w = await world();
  try {
    await w.warden(w.stranger);
    for (const who of ['owner', 'device'] as const) {
      const board = await w.get(who, `/v1/ferrets/${w.stranger}/agenda`);
      expect(board.status).toBe(200);
      for (const text of [SECRET_WHY, SECRET_CONTEXT, SECRET_REMEDY]) expect(board.body).toContain(text);
      const id = board.json<{ items: { id: string }[] }>().items[0]?.id;
      for (const suffix of ROUTES) {
        const read = await w.get(who, `/v1/ferrets/${w.stranger}/agenda/${id}${suffix}`);
        expect([who, suffix, read.status]).toEqual([who, suffix, 200]);
      }
      const item = await w.get(who, `/v1/ferrets/${w.stranger}/agenda/${id}`);
      expect(item.body).toContain(SECRET_WHY);
      expect(item.body).toContain('sourceRef');
    }
    // The owner's and the device's bytes are the same.
    expect((await w.get('owner', `/v1/ferrets/${w.stranger}/agenda`)).body).toBe(
      (await w.get('device', `/v1/ferrets/${w.stranger}/agenda`)).body,
    );
  } finally {
    await w.host.stop();
  }
});
