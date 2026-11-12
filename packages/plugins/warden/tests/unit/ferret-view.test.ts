import { describe, expect, test } from 'bun:test';
import { ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallContext, CallStanding, CarrierKey, FerretId } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { DEFAULT_WARDEN_CONFIG } from '../../contract/index.ts';
import { wardenRoutes } from '../../daemon/routes.ts';
import type { WardenSubsystem } from '../../daemon/subsystem.ts';
import {
  ferretAgendaView,
  ferretRunView,
  ferretStatusView,
  ferretVerdictsView,
  reportReadableBy,
  type WardenReadScope,
} from '../../daemon/lib/index.ts';

/**
 * Audit A fix 4: `ferretWardenView` is DENY BY DEFAULT. Each projection builds a ferret's answer from an allowlist, so a
 * field added to the owner's view later is absent for a ferret until someone lists it. Every test here plants a field
 * the projection has never heard of — on the view and on every kind of row — and proves it does not leave. Fixture
 * values only.
 */

const MINE = 'mine-1' as FerretId;
const HELPER = 'mine-2' as FerretId;
const STRANGER = 'other-9' as FerretId;
const scope: WardenReadScope = { mayRead: ferret => ferret === MINE || ferret === HELPER };
const AT = '2026-11-06T09:00:00.000Z' as Instant;
const NEW = { zzNewField: 'secret-new-field', zzNewNumber: 4242 };

const flag = (ferret: FerretId, extra: Record<string, unknown> = {}) => ({
  kind: 'sus_thinking' as const,
  ferret,
  state: 'working' as const,
  detail: `detail of ${ferret}`,
  ...extra,
});

const ownerStatus = () =>
  ({
    config: DEFAULT_WARDEN_CONFIG,
    lastSweepAt: AT,
    nextSweepAt: AT,
    flags: [flag(MINE, NEW), flag(STRANGER, NEW)],
    fingerprint: `sus_thinking:${STRANGER}`,
    liveWarden: 'warden-of-stranger',
    lastSpawnAt: AT,
    lastReport: { reportId: 'r.md', head: '# report' },
    triage: {
      jev: { configured: true, active: false, reason: 'jev_cap', ...NEW },
      llm: { configured: true, active: true, reason: 'configured', ...NEW },
      ...NEW,
    },
    spend: { day: '2026-11-06', jevUsd: 1, jevCapUsd: 2, investigationUsd: 3, investigationCapUsd: 4 },
    savings: { day: '2026-11-06', flags: 9 },
    investigations: [
      { id: 'i1', state: 'done', scope: 'ferret', origin: 'owner', target: MINE, warden: 'w1', ...NEW },
      { id: 'i2', state: 'done', scope: 'ferret', origin: 'owner', target: STRANGER, warden: 'w2', ...NEW },
      { id: 'i3', state: 'done', scope: 'pack', origin: 'owner', ...NEW },
    ],
    actions: [
      { at: AT, ferret: MINE, action: 'revive', outcome: 'done', by: 'jev', detail: 'mine', ...NEW },
      { at: AT, ferret: STRANGER, action: 'revive', outcome: 'done', by: 'jev', detail: 'theirs', ...NEW },
    ],
    blessings: [
      { ferret: MINE, kinds: ['sus_thinking'], expiresAt: AT, by: 'jev', streak: 3, ...NEW },
      { ferret: STRANGER, kinds: ['sus_thinking'], expiresAt: AT, by: 'jev', streak: 17, ...NEW },
    ],
    history: [{ day: '2026-11-06' }],
    actionTotals: [{ action: 'revive' }],
    reviveTotals: { progressed: { auto: 7 } },
    jevChecks: [
      { at: AT, ferret: MINE, anomalyKind: 'sus_thinking', verdict: 'healthy', confidence: 0.9, costUsd: 0.1, ...NEW },
      {
        at: AT,
        ferret: STRANGER,
        anomalyKind: 'sus_thinking',
        verdict: 'healthy',
        confidence: 0.9,
        costUsd: 9,
        ...NEW,
      },
    ],
    failover: {
      policy: 'fallback',
      failureThreshold: 3,
      cooldownMinutes: 30,
      accounts: [{ agent: 'work', eligible: true, reason: 'demoted until later', strikes: 13, ...NEW }],
      lastSelection: { agent: 'work' },
      exhaustedSince: AT,
      ...NEW,
    },
    login: { source: 'configured', unknown: [], available: ['work'], ...NEW },
    ...NEW,
  }) as unknown as Parameters<typeof ferretStatusView>[0];

describe('ferretStatusView is deny by default', () => {
  test('a field the owner’s view gains later is absent for a ferret, at every level', () => {
    const view = ferretStatusView(ownerStatus(), scope);
    const text = JSON.stringify(view);
    expect(text).not.toContain('zzNew');
    expect(text).not.toContain('secret-new-field');
    expect(text).not.toContain('4242');
    expect(Object.keys(view).toSorted()).toEqual(
      [
        'actions',
        'blessings',
        'config',
        'failover',
        'fingerprint',
        'flags',
        'investigations',
        'jevChecks',
        'lastReport',
        'lastSweepAt',
        'login',
        'nextSweepAt',
        'triage',
        'wardenRunning',
      ].toSorted(),
    );
  });

  test('no figure, identity or activity of another lineage survives', () => {
    const view = ferretStatusView(ownerStatus(), scope);
    const text = JSON.stringify(view);
    for (const hidden of [STRANGER, 'theirs', 'warden-of-stranger', '"streak":17', '"costUsd":9', 'strikes', 'demoted'])
      expect(text).not.toContain(hidden);
    for (const aggregate of ['spend', 'savings', 'history', 'actionTotals', 'reviveTotals', 'lastSpawnAt'])
      expect(view).not.toHaveProperty(aggregate);
    expect(view.fingerprint).toBe('');
    expect(view.liveWarden).toBeUndefined();
    expect(view.wardenRunning).toBe(true);
    expect(view.flags.map(entry => entry.ferret)).toEqual([MINE]);
    expect(view.investigations.map(entry => entry.id)).toEqual(['i1']);
    expect(view.actions.map(entry => entry.ferret)).toEqual([MINE]);
    expect(view.blessings.map(entry => entry.ferret)).toEqual([MINE]);
    expect(view.jevChecks?.map(entry => entry.ferret)).toEqual([MINE]);
    expect(view.failover).toEqual({
      policy: 'fallback',
      failureThreshold: 3,
      cooldownMinutes: 30,
      accounts: [{ agent: 'work', eligible: true }],
    });
  });

  test('a Warden id is named only when it investigates one of the lineage’s own', () => {
    expect(ferretStatusView({ ...ownerStatus(), liveWarden: 'w1' }, scope).liveWarden).toBe('w1');
    expect(ferretStatusView({ ...ownerStatus(), liveWarden: undefined }, scope).wardenRunning).toBe(false);
  });

  test('a fleet-wide flag names only the lineage’s share and says nothing of the others', () => {
    const fleet = flag(STRANGER, {
      kind: 'dead_monitor',
      affectedFerrets: [STRANGER, MINE, 'other-8'],
      detail: `3 active sessions unsupervised: ${STRANGER}, ${MINE}, other-8`,
      provider: 'anthropic',
      models: ['their-model'],
      failureClasses: ['theirs'],
      name: 'theirname',
    });
    const view = ferretStatusView(
      { ...ownerStatus(), flags: [fleet, flag(STRANGER, { affectedFerrets: ['other-7'] })] },
      scope,
    );
    expect(view.flags).toHaveLength(1);
    const [kept] = view.flags;
    expect(kept?.affectedFerrets).toEqual([MINE]);
    expect(kept?.ferret).toBe(MINE);
    const text = JSON.stringify(view);
    for (const hidden of [STRANGER, 'other-8', 'other-7', 'their-model', 'theirs', 'theirname', '3 active'])
      expect(text).not.toContain(hidden);
  });
});

describe('the other Warden reads are deny by default too', () => {
  test('a verdict keeps its lineage rows and an allowlist of fields', () => {
    const view = ferretVerdictsView(
      [
        {
          at: AT,
          target: MINE,
          verdict: 'cleared',
          reportPath: 'reports/a.md',
          spawn: { agent: 'work', model: 'm', skipped: { x: 'y' } },
          ...NEW,
        },
        { at: AT, target: STRANGER, verdict: 'cleared', reportPath: 'reports/b.md' },
        { at: AT, verdict: 'cleared', reportPath: 'reports/c.md' },
      ] as unknown as Parameters<typeof ferretVerdictsView>[0],
      scope,
    );
    expect(view.map(entry => entry.target)).toEqual([MINE]);
    expect(JSON.stringify(view)).not.toMatch(/zzNew|secret-new-field|"skipped"/u);
  });

  test('an agenda keeps its lineage items; an empty one is an all-clear, never "items"', () => {
    const item = (ferret: FerretId) => ({
      ferret,
      id: `${ferret}-1`,
      source: 'warden-flag' as const,
      subject: `subject ${ferret}`,
      why: 'why',
      waitingSince: AT,
      howToResolve: 'how',
      ...NEW,
    });
    const owner = {
      generatedAt: AT,
      lastSweepAt: AT,
      outcome: 'items',
      items: [item(MINE), item(STRANGER)],
      verdictCoverage: { limit: 100, truncated: false },
      ...NEW,
    } as unknown as Parameters<typeof ferretAgendaView>[0];
    const view = ferretAgendaView(owner, scope);
    expect(view.items.map(entry => entry.ferret)).toEqual([MINE]);
    expect(JSON.stringify(view)).not.toMatch(/zzNew|secret-new-field|other-9/u);
    const none = ferretAgendaView({ ...owner, items: [item(STRANGER)] }, scope);
    expect(none.items).toEqual([]);
    expect(none.outcome).toBe('clean-sweep');
    expect(ferretAgendaView({ ...owner, items: [], lastSweepAt: undefined }, scope).outcome).toBe('no-sweep');
  });

  test('a run keeps when it looked and the lineage’s flags, with no spawn, warden or sentence', () => {
    const view = ferretRunView(
      {
        sweptAt: AT,
        flags: [flag(MINE), flag(STRANGER)],
        spawned: 'warden-of-stranger',
        assignedWardens: ['warden-of-stranger'],
        message: 'investigations are off: 3 flags, $0.45678 spent',
        ...NEW,
      } as unknown as Parameters<typeof ferretRunView>[0],
      scope,
    );
    expect(view).toEqual({ sweptAt: AT, flags: [flag(MINE)] });
  });

  test('a report is a caller’s only when every entry in it is about the lineage', () => {
    expect(reportReadableBy([MINE], scope)).toBe(true);
    expect(reportReadableBy([MINE, HELPER], scope)).toBe(true);
    expect(reportReadableBy([MINE, STRANGER], scope)).toBe(false);
    expect(reportReadableBy([MINE, undefined], scope)).toBe(false);
    expect(reportReadableBy([undefined], scope)).toBe(false);
    expect(reportReadableBy([], scope)).toBe(false);
  });
});

// ─── the route spine: a stand-in subsystem that answers the owner's whole fleet ─────────────────────────────────────

const unreached = (): never => {
  throw new Error('not reached');
};

const callOf = (standing: CallStanding, method: string, path: string, body?: unknown): CallContext => ({
  request: {
    method,
    path,
    query: new Map(),
    headers: new Map([['content-type', 'application/json']]),
    arrival: { kind: 'carried', carrier: 'direct' as CarrierKey },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  },
  params: new Map(),
  ...standing,
});

const anomaly = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'sus_thinking',
  sessionId,
  status: 'thinking',
  detail: `detail of ${sessionId}`,
  ...extra,
});

describe('POST /v1/warden/run answers a ferret through the projection', () => {
  const subsystem: WardenSubsystem = {
    run: async () =>
      ({
        sweptAt: AT,
        anomalies: [anomaly(MINE), anomaly(STRANGER)],
        spawned: 'warden-of-stranger',
        assignedWardens: ['warden-of-stranger'],
        message: 'investigations are off: 9 flags, $0.45678 spent',
      }) as never,
    status: unreached,
    verdicts: unreached,
    report: unreached,
    config: unreached,
    updateConfig: unreached,
    agenda: unreached,
    investigate: unreached,
    leave: unreached,
    nudgeSweep: unreached,
    arm: unreached,
  };
  const routes = wardenRoutes(subsystem, { mayTouch: (_caller, target) => target === MINE || target === HELPER });

  test('a ferret reads only its own flags and no spawn, warden id or fleet sentence', async () => {
    const answered = await routes['POST /v1/warden/run'](
      callOf(ferretStanding(MINE as FerretId), 'POST', '/v1/warden/run', { spawn: false }),
    );
    expect(answered.status).toBe(200);
    const text = String(answered.body);
    for (const hidden of [STRANGER, 'warden-of-stranger', '0.45678', '9 flags']) expect(text).not.toContain(hidden);
    expect(JSON.parse(text)).toEqual({ sweptAt: AT, flags: [expect.objectContaining({ ferret: MINE })] });
  });

  test('the owner reads the whole answer, unchanged', async () => {
    const answered = await routes['POST /v1/warden/run'](
      callOf(ownerStanding(), 'POST', '/v1/warden/run', { spawn: false }),
    );
    const text = String(answered.body);
    for (const shown of [STRANGER, 'warden-of-stranger', '0.45678', '9 flags']) expect(text).toContain(shown);
  });
});
