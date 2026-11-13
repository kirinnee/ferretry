import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { deviceStanding, FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';
import golden from './fixtures/warden-status-owner-fix3.json';

/**
 * Audit A fix 4: the owner's and an enrolled device's `GET /v1/warden/status` are BYTE FOR BYTE what they were before
 * the ferret projection existed. The golden bodies were captured from the audit-A fix 3 tip (a82d7fafe6) over this same
 * deterministic fixture: an empty Warden, then flags, actions, a blessing, a fingerprint, spawn and sweep times, a
 * target and a pack investigation, daily aggregates, a report and 55 Jev checks. The owner is the admin bearer over the
 * stand-in admission's `ownerStanding` (the kernel cannot import Gate's daemon); the person is its `deviceStanding`. Both must also equal each other.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const PERSON_HEADER = 'x-test-person';

const world = async () => {
  const host = await testHost({
    plugins: [
      real('ferrets'),
      real('usage'),
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
    gate: new StandInAdmission(request =>
      request.headers.get(PERSON_HEADER) === undefined ? ownerStanding() : deviceStanding('phone'),
    ),
    fakes: {
      gate: new FakeGate(),
      vault: new FakeVault(),
      asks: new FakeAsks(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
    },
  });
  // Four stopped ferrets, as the fix 3 capture had; the bodies below name none of them.
  for (let count = 0; count < 4; count += 1) {
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: '/work/project' },
    });
    const { id } = started.json<{ id: string }>();
    await host.request('POST', `/v1/ferrets/${id}/stop`);
  }
  return host;
};

const bodiesOf = async (host: Awaited<ReturnType<typeof world>>) => {
  const owner = await host.request('GET', '/v1/warden/status');
  const person = await host.request('GET', '/v1/warden/status', { headers: { [PERSON_HEADER]: 'phone' } });
  expect([owner.status, person.status]).toEqual([200, 200]);
  return { owner: owner.body, person: person.body };
};

/** JSON.stringify of the parsed body is the body itself (compact, key order kept) — whitespace aside. */
const canonical = (body: string): string => JSON.stringify(JSON.parse(body));

test('audit A fix 4 the owner and a person read the same bytes the fix 3 tip served, empty and populated', async () => {
  const host = await world();
  try {
    const empty = await bodiesOf(host);
    expect(canonical(empty.owner)).toBe(JSON.stringify(golden.baseline));
    expect(empty.person).toBe(empty.owner);

    const at = host.clock.now();
    const day = at.slice(0, 10);
    const zeros = { auto: 0, jev: 0, llm: 0 };
    host.state('warden').files.set(
      'state.json',
      JSON.stringify({
        format: 1,
        lastSweepAt: at,
        lastSpawnAt: at,
        lastFingerprint: 'fixed-fingerprint',
        lastAnomalies: [
          { kind: 'sus_thinking', sessionId: 'fixed-victim', status: 'thinking', detail: 'fixed fixture' },
        ],
        actions: [
          { at, sessionId: 'fixed-victim', action: 'revive', outcome: 'done', by: 'jev', detail: 'fixed fixture' },
        ],
        blessings: {
          victim: {
            sessionId: 'fixed-victim',
            kinds: ['sus_thinking'],
            status: 'thinking',
            blessedAt: at,
            expiresAt: '2099-01-01T00:00:00.000Z',
            by: 'jev',
            streak: 17,
          },
        },
        triageDay: { day, flags: 1, jevDecisions: 1, jevSkips: 1, jevUsd: 0.12345 },
        costAverage: { count: 1, totalUsd: 0.77 },
        investigations: [
          {
            id: 'inv-fixed',
            scope: 'session',
            origin: 'owner',
            targetId: 'fixed-victim',
            startedAt: at,
            finishedAt: at,
            reportPath: 'reports/fixed.md',
            costUsd: 0.77,
          },
          {
            id: 'inv-pack',
            scope: 'fleet',
            origin: 'owner',
            startedAt: at,
            finishedAt: at,
            reportPath: 'reports/pack.md',
            costUsd: 0.45678,
          },
        ],
        daily: [
          {
            day,
            flags: 1,
            jevDecisions: 1,
            investigations: 1,
            jevUsd: 0.12345,
            investigationUsd: 0.77,
            moved: zeros,
            cleared: zeros,
            stopped: zeros,
            asked: zeros,
            acts: [{ action: 'revive', outcome: 'done', auto: 7, jev: 0, llm: 0 }],
            reviveResults: { progressed: { auto: 7, jev: 0, llm: 0 }, stalled: zeros },
          },
        ],
      }),
    );
    host
      .state('warden')
      .bytes.set('reports/2026-11-06T09-00-00-000Z.md', new TextEncoder().encode('# fixed report\nVERDICT: cleared'));
    host.state('warden').files.set(
      `jev-checks/${day}.json`,
      JSON.stringify({
        format: 1,
        checks: Array.from({ length: 55 }, (_, index) => ({
          at,
          sessionId: `fixed-target-${index}`,
          anomalyKind: 'sus_thinking',
          verdict: 'healthy',
          confidence: 0.9,
          costUsd: 0.0011,
        })),
      }),
    );
    const populated = await bodiesOf(host);
    expect(canonical(populated.owner)).toBe(JSON.stringify(golden.populated));
    expect(populated.person).toBe(populated.owner);
  } finally {
    await host.stop();
  }
});
