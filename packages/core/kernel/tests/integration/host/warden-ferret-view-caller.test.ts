import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners, type FerretId } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * Audit A fix 4: every Warden read a FERRET can make, through the REAL Ferrets and the REAL Warden halves behind the
 * stand-in admission (the kernel cannot import Gate's daemon, `context-imports`): the caller's standing is the stand-in's
 * `ferretStanding`, the same `credential.tokenClass: 'ferret'` the production Gate admits a ferret bearer with.
 * `core/gate/tests/unit/daemon/warden-routes-caller.test.ts` runs the real `GateAdmission` over the shipped Warden routes
 * and shows each admits a ferret bearer as that ferret, and refuses a ferret the person-only ones. One projection (`ferretWardenView`) is applied at the route
 * spine, deny by default: a ferret sees its own lineage's rows (itself and its helpers, Ferrets' `mayTouch`) and plain
 * states, and nothing about any other lineage. The owner and a person read the whole fleet, byte for byte
 * (`warden-owner-bytes.test.ts`). Fixture values only: no model, no spend, no real notice.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const COST = '0.45678';
const CALLER_HEADER = 'x-test-caller';

const world = async () => {
  const asks = new FakeAsks();
  const host = await testHost({
    plugins: [
      real('ferrets'),
      real('warden'),
      real('packs'),
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
      return caller === undefined ? ownerStanding() : ferretStanding(caller as FerretId);
    }),
    fakes: {
      gate: new FakeGate(),
      vault: new FakeVault(),
      asks,
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
    },
  });
  const start = async (parent?: string, label?: string): Promise<string> => {
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: {
        folder: '/work/project',
        ...(parent === undefined ? {} : { parent }),
        ...(label === undefined ? {} : { label }),
      },
    });
    expect([started.status, JSON.stringify(started.json())]).toEqual([201, expect.anything()]);
    return started.json<{ id: string }>().id;
  };
  const begin = async (parent?: string): Promise<string> => {
    const id = await start(parent);
    const stopped = await host.request('POST', `/v1/ferrets/${id}/stop`);
    expect(stopped.status).toBe(200);
    return id;
  };
  // lead -> helper is one lineage; victim is a stranger with its own activity.
  const lead = await begin();
  const helper = await begin(lead);
  const victim = await begin();
  const as = async (caller: string | undefined, path: string, query?: Record<string, string>) => {
    return await host.request('GET', path, {
      ...(caller === undefined ? {} : { headers: { [CALLER_HEADER]: caller } }),
      ...(query === undefined ? {} : { query }),
    });
  };
  const status = async (caller?: string) => {
    const response = await as(caller, '/v1/warden/status');
    expect(response.status).toBe(200);
    return response.json<Record<string, any>>();
  };
  return { host, asks, lead, helper, victim, start, as, status };
};

type World = Awaited<ReturnType<typeof world>>;

const record = (host: World['host'], id: string, targetId: string) => ({
  id,
  scope: 'session',
  origin: 'owner',
  targetId,
  startedAt: host.clock.now(),
  finishedAt: host.clock.now(),
  reportPath: `reports/${id}.md`,
  costUsd: 0.0011,
});

const report = (host: World['host'], name: string, text: string) =>
  host.state('warden').bytes.set(`reports/${name}`, new TextEncoder().encode(text));

// ─── status: every runtime field is lineage-only or a plain state ─────────────────────────────────────────────────

for (const field of ['flags', 'actions', 'blessings', 'fingerprint', 'lastSpawnAt', 'lastReport', 'failover']) {
  test(`audit A fix 4 status ${field} cannot reveal unrelated lineage activity`, async () => {
    const w = await world();
    const { host, victim } = w;
    try {
      if (field === 'failover') host.setConfig('warden.yaml', { accounts: [{ agent: 'work' }] });
      const before = await w.status(w.lead);
      const at = host.clock.now();
      host.state('warden').files.set(
        'state.json',
        JSON.stringify({
          format: 1,
          lastAnomalies: [
            {
              kind: 'sus_thinking',
              sessionId: victim,
              status: 'thinking',
              detail: `fixture victim activity ${victim}`,
            },
          ],
          lastFingerprint: `fixture victim fingerprint ${victim}`,
          lastSpawnAt: at,
          actions: [
            {
              at,
              sessionId: victim,
              action: 'revive',
              outcome: 'done',
              by: 'jev',
              detail: `fixture victim remedy ${victim}`,
            },
          ],
          blessings: {
            [victim]: {
              sessionId: victim,
              kinds: ['sus_thinking'],
              status: 'thinking',
              blessedAt: at,
              expiresAt: '2099-01-01T00:00:00.000Z',
              by: 'jev',
              streak: 17,
            },
          },
          failover: {
            strikes: { work: { count: 13, lastAt: at, lastReason: 'fixture victim investigation failed' } },
            demotedUntil: { work: '2099-01-01T00:00:00.000Z' },
            lastSelection: { agent: 'work', policy: 'fallback', at, reason: 'preferred' },
            exhaustedSince: at,
          },
        }),
      );
      report(
        host,
        `2026-11-06T09-00-00-000Z-${victim}.md`,
        `# Warden report for ${victim}\n\nVERDICT: cleared\n\nVictim diagnostic cost $${COST}`,
      );
      const after = await w.status(w.lead);
      expect(after[field]).toEqual(before[field]);
    } finally {
      await host.stop();
    }
  });
}

test('audit A fix 4 an unrelated running Warden is a boolean, never an id', async () => {
  const w = await world();
  const { host } = w;
  try {
    const before = await w.status(w.lead);
    const id = await w.start(undefined, 'fleet-warden');
    const after = await w.status(w.lead);
    expect(after.liveWarden).toEqual(before.liveWarden);
    expect(JSON.stringify(after)).not.toContain(id);
    expect(after.wardenRunning).toBe(true);
    // The owner still reads the warden's id.
    expect((await w.status()).liveWarden).toBe(id);
  } finally {
    await host.stop();
  }
});

test("audit A fix 4 a ferret's own lineage rows stay readable, with no other lineage beside them", async () => {
  const w = await world();
  const { host, lead, helper, victim } = w;
  try {
    const at = host.clock.now();
    const action = (sessionId: string) => ({
      at,
      sessionId,
      action: 'revive',
      outcome: 'done',
      by: 'jev',
      detail: `fixture ${sessionId}`,
    });
    const flag = (sessionId: string) => ({
      kind: 'sus_thinking',
      sessionId,
      status: 'thinking',
      detail: `fixture ${sessionId}`,
    });
    const blessing = (sessionId: string) => ({
      sessionId,
      kinds: ['sus_thinking'],
      status: 'thinking',
      blessedAt: at,
      expiresAt: '2099-01-01T00:00:00.000Z',
      by: 'jev',
      streak: 3,
    });
    host.state('warden').files.set(
      'state.json',
      JSON.stringify({
        format: 1,
        lastAnomalies: [flag(lead), flag(victim), flag(helper)],
        actions: [action(victim), action(lead), action(helper)],
        blessings: { a: blessing(victim), b: blessing(lead) },
      }),
    );
    const own = await w.status(lead);
    expect(own.flags.map((entry: { ferret: string }) => entry.ferret).toSorted()).toEqual([helper, lead].toSorted());
    expect(own.actions.map((entry: { ferret: string }) => entry.ferret).toSorted()).toEqual([helper, lead].toSorted());
    expect(own.blessings.map((entry: { ferret: string }) => entry.ferret)).toEqual([lead]);
    expect(JSON.stringify(own)).not.toContain(victim);
    // The owner reads all of it.
    const owner = await w.status();
    expect(owner.flags).toHaveLength(3);
    expect(owner.actions).toHaveLength(3);
    expect(owner.blessings).toHaveLength(2);
  } finally {
    await host.stop();
  }
});

test('audit A fix 4 unrelated actions cannot evict the only readable action before the lineage filter', async () => {
  const w = await world();
  const { host, lead, victim } = w;
  try {
    const at = host.clock.now();
    const action = (sessionId: string) => ({
      at,
      sessionId,
      action: 'revive',
      outcome: 'done',
      by: 'jev',
      detail: `fixture ${sessionId}`,
    });
    host.state('warden').files.set('state.json', JSON.stringify({ format: 1, actions: [action(lead)] }));
    const before = (await w.status(lead)).actions;
    expect(before).toHaveLength(1);
    host
      .state('warden')
      .files.set(
        'state.json',
        JSON.stringify({ format: 1, actions: [...Array.from({ length: 25 }, () => action(victim)), action(lead)] }),
      );
    expect((await w.status(lead)).actions).toEqual(before);
  } finally {
    await host.stop();
  }
});

test('audit A fix 4 unrelated investigation records cannot evict the only readable investigation', async () => {
  const w = await world();
  const { host, lead, victim } = w;
  try {
    const own = record(host, 'inv-own', lead);
    host.state('warden').files.set('state.json', JSON.stringify({ format: 1, investigations: [own] }));
    const before = (await w.status(lead)).investigations;
    expect(before).toHaveLength(1);
    host.state('warden').files.set(
      'state.json',
      JSON.stringify({
        format: 1,
        investigations: [...Array.from({ length: 20 }, (_, index) => record(host, `inv-other-${index}`, victim)), own],
      }),
    );
    expect((await w.status(lead)).investigations).toEqual(before);
    // The owner still reads the newest twenty, whoever they were about.
    expect((await w.status()).investigations).toHaveLength(20);
  } finally {
    await host.stop();
  }
});

test('audit A fix 6 a ferret’s status carries no latest report at all, and the owner’s is the newest of all', async () => {
  const w = await world();
  const { host, lead, victim } = w;
  try {
    report(host, `2026-11-06T09-00-00-000Z-${lead}.md`, `# Warden report — ${lead}\n\nVERDICT: cleared\n\nown note`);
    expect(await w.status(lead)).not.toHaveProperty('lastReport');
    report(
      host,
      `2026-11-06T10-00-00-000Z-${victim}.md`,
      `# Warden report — ${victim}\n\nVERDICT: cleared\n\n$${COST}`,
    );
    const after = await w.status(lead);
    expect(after).not.toHaveProperty('lastReport');
    expect(JSON.stringify(after)).not.toContain(COST);
    // The owner's latest is the newest of all.
    expect((await w.status()).lastReport.reportId).toBe(`2026-11-06T10-00-00-000Z-${victim}.md`);
  } finally {
    await host.stop();
  }
});

// ─── verdicts, report, agenda ────────────────────────────────────────────────────────────────────────────────────

const anomalyReport = (id: string, name: string) =>
  `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n## Anomaly: ${id} — ${name}\nVERDICT: needs_human\nREASON: fixture diagnostic cost $${COST}\n`;

for (const route of ['verdicts', 'report', 'agenda'] as const) {
  test(`audit A fix 4 ${route} read cannot return another lineage report`, async () => {
    const w = await world();
    const { host, lead, victim } = w;
    try {
      const file = `2026-11-06T09-00-00-000Z-${victim}.md`;
      report(host, file, anomalyReport(victim, 'Victim'));
      const response = await w.as(lead, `/v1/warden/${route}`, route === 'report' ? { path: file } : undefined);
      // A stranger's report is not found (never "forbidden"), so its existence is not confirmed.
      expect(response.status).toBe(route === 'report' ? 404 : 200);
      expect(response.body).not.toContain(victim);
      expect(response.body).not.toContain(COST);
    } finally {
      await host.stop();
    }
  });
}

test('audit A fix 6 a ferret reads its own verdicts and no report, its own included; the owner reads every one', async () => {
  const w = await world();
  const { host, lead, helper, victim } = w;
  try {
    const own = `2026-11-06T09-00-00-000Z-${lead}.md`;
    const other = `2026-11-06T10-00-00-000Z-${victim}.md`;
    report(host, own, anomalyReport(lead, 'Lead'));
    report(host, other, anomalyReport(victim, 'Victim'));
    const verdicts = await w.as(lead, '/v1/warden/verdicts');
    expect(verdicts.json<{ target: string }[]>().map(entry => entry.target)).toEqual([lead]);
    const read = await w.as(lead, '/v1/warden/report', { path: own });
    expect(read.status).toBe(404);
    expect(read.body).not.toContain('needs_human');
    expect((await w.as(helper, '/v1/warden/report', { path: own })).status).toBe(404);
    expect((await w.as(lead, '/v1/warden/report', { path: other })).status).toBe(404);
    const owner = await w.as(undefined, '/v1/warden/verdicts');
    expect(
      owner
        .json<{ target: string }[]>()
        .map(entry => entry.target)
        .toSorted(),
    ).toEqual([lead, victim].toSorted());
    expect((await w.as(undefined, '/v1/warden/report', { path: other })).status).toBe(200);
  } finally {
    await host.stop();
  }
});

test('audit A fix 4 a report that names a stranger beside the caller is not the caller’s to read', async () => {
  const w = await world();
  const { host, lead, victim } = w;
  try {
    const shared = '2026-11-06T09-00-00-000Z.md';
    report(
      host,
      shared,
      `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n## Anomaly: ${lead} — Lead\nVERDICT: cleared\n\n## Anomaly: ${victim} — Victim\nVERDICT: needs_human\nREASON: cost $${COST}\n`,
    );
    report(host, '2026-11-06T09-30-00-000Z.md', '# Warden pack report\n\nVERDICT: cleared\n\nno target at all');
    expect((await w.as(lead, '/v1/warden/report', { path: shared })).status).toBe(404);
    expect((await w.as(lead, '/v1/warden/report', { path: '2026-11-06T09-30-00-000Z.md' })).status).toBe(404);
    const verdicts = await w.as(lead, '/v1/warden/verdicts');
    expect(verdicts.body).not.toContain(victim);
    expect(verdicts.body).not.toContain(COST);
  } finally {
    await host.stop();
  }
});

test('audit A fix 4 unrelated reports cannot evict the only readable verdict before the lineage filter', async () => {
  const w = await world();
  const { host, lead, victim } = w;
  try {
    report(host, `2026-11-01T09-00-00-000Z-${lead}.md`, anomalyReport(lead, 'Lead'));
    const before = (await w.as(lead, '/v1/warden/verdicts')).json<unknown[]>();
    expect(before).toHaveLength(1);
    for (let index = 0; index < 60; index += 1)
      report(
        host,
        `2026-11-02T09-${String(index).padStart(2, '0')}-00-000Z-${victim}.md`,
        anomalyReport(victim, 'Victim'),
      );
    expect((await w.as(lead, '/v1/warden/verdicts')).json<unknown[]>()).toEqual(before);
  } finally {
    await host.stop();
  }
});

test('audit A fix 4 agenda cannot name a stranger notification, and an empty one is not a hint', async () => {
  const w = await world();
  const { host, lead, asks, start } = w;
  try {
    const victim = await start();
    await asks.notify({
      source: 'daemon' as never,
      entry: `f.${victim}.warden:ask:sus_thinking` as never,
      ref: { ferret: victim, kind: 'sus_thinking' },
      subject: `fixture victim ${victim}`,
      why: `fixture victim cost $${COST}`,
      howToResolve: 'fixture only',
      raisedBy: { kind: 'daemon' },
      ferret: victim,
    });
    const response = await w.as(lead, '/v1/warden/agenda');
    expect(response.status).toBe(200);
    expect(response.body).not.toContain(victim);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
    // The owner sees the notification.
    expect((await w.as(undefined, '/v1/warden/agenda')).body).toContain(victim);
  } finally {
    await host.stop();
  }
});

test('audit A fix 6 an escalation about the caller reaches it as fixed sentences, and the owner still reads the text', async () => {
  const w = await world();
  const { host, asks, start } = w;
  try {
    const lead = await start();
    const victim = await start();
    await asks.notify({
      source: 'daemon' as never,
      entry: `f.${lead}.warden:ask:unattended_question` as never,
      ref: { ferret: lead, kind: 'unattended_question' },
      subject: `${victim} is stuck`,
      why: `${victim} burned $${COST} on the migration`,
      context: `Remedy: move it like ${victim}`,
      howToResolve: `Ask ${victim} for the key`,
      raisedBy: { kind: 'daemon' },
      ferret: lead,
    });
    const response = await w.as(lead, '/v1/warden/agenda');
    expect(response.status).toBe(200);
    for (const hidden of [victim, COST, 'migration', 'Remedy']) expect(response.body).not.toContain(hidden);
    const [item] = response.json<{ items: Record<string, unknown>[] }>().items;
    expect(item).toMatchObject({
      ferret: lead,
      anomalyKind: 'unattended_question',
      subject: 'The Warden flagged this ferret: it asked a question and nobody has answered.',
      why: 'The Warden asked the owner to look at this. The Warden’s reasons are the owner’s to read.',
      howToResolve: 'Nothing to answer here: the owner decides. Carry on with your work.',
    });
    expect(item).not.toHaveProperty('context');
    // The owner reads the notification's own words.
    const owner = (await w.as(undefined, '/v1/warden/agenda')).body;
    expect(owner).toContain(victim);
  } finally {
    await host.stop();
  }
});

test('audit A fix 4 the ferret agenda never reads "items" for an owner-only notification', async () => {
  const w = await world();
  const { host, lead, asks, start } = w;
  try {
    const victim = await start();
    await asks.notify({
      source: 'daemon' as never,
      entry: `f.${victim}.warden:ask:sus_thinking` as never,
      ref: { ferret: victim, kind: 'sus_thinking' },
      subject: 'fixture',
      why: 'fixture',
      howToResolve: 'fixture only',
      raisedBy: { kind: 'daemon' },
      ferret: victim,
    });
    const body = (await w.as(lead, '/v1/warden/agenda')).json<{ outcome: string; items: unknown[] }>();
    expect(body.items).toEqual([]);
    expect(body.outcome).not.toBe('items');
  } finally {
    await host.stop();
  }
});
