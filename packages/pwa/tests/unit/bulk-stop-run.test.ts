import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { BulkStopRequest } from '../../src/shell/agent-sidebar-model.ts';
import { type BulkStopApi, bulkStopRequest, runBulkStop } from '../../src/shell/bulk-stop-run.ts';
import { sessionView } from '../support/sessions.ts';

const running = (id: string, overrides: Parameters<typeof sessionView>[1] = {}): SessionView =>
  sessionView(id, { ...overrides, state: { status: 'running', ...overrides.state } });

/** lead → kid → grandkid, plus an unrelated session on the same daemon. */
const family = (): SessionView[] => [
  running('lead', { config: { label: 'batch' } }),
  running('kid', { config: { parent: 'lead' } }),
  running('grandkid', { config: { parent: 'kid' } }),
  running('stranger'),
];

interface Recorded {
  readonly stopped: string[];
  readonly reasons: string[];
  readonly upserted: string[];
  readonly lists: number;
}

const deps = (
  lists: readonly (readonly SessionView[] | Error)[],
  stop: (id: string) => SessionView | Error = id => running(id, { state: { status: 'stopped' } }),
) => {
  const stopped: string[] = [];
  const reasons: string[] = [];
  const upserted: string[] = [];
  let listCall = 0;
  const api: BulkStopApi<'alpha'> = {
    listSessions: async () => {
      const answer = lists[Math.min(listCall++, lists.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    stop: async (_daemon, sessionId, reason) => {
      stopped.push(sessionId);
      reasons.push(reason);
      const answer = stop(sessionId);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const recorded: Recorded = {
    stopped,
    reasons,
    upserted,
    get lists() {
      return listCall;
    },
  } as Recorded;
  return {
    recorded,
    deps: { api, daemon: 'alpha' as const, onUpsert: (view: SessionView) => upserted.push(view.config.id) },
  };
};

describe('bulkStopRequest', () => {
  test('captures the exact targets a cascade would hit', () => {
    const request = bulkStopRequest(family(), 'lead', 'cascade', 1);
    expect(request?.targets.map(view => view.config.id).sort()).toEqual(['grandkid', 'kid', 'lead']);
    expect(request?.orphanedDescendants).toBeUndefined();
  });

  test('leads an orphan sweep with the descendants it deliberately leaves alive', () => {
    const request = bulkStopRequest(family(), 'lead', 'orphan', 2);
    expect(request?.targets.map(view => view.config.id)).toEqual(['lead']);
    expect(request?.orphanedDescendants?.map(view => view.config.id).sort()).toEqual(['grandkid', 'kid']);
  });

  test('records the label as the durable identity of a label sweep', () => {
    const request = bulkStopRequest(family(), 'lead', 'label', 3);
    expect(request?.labelIdentity).toBe('batch');
  });

  test('refuses to open a label sweep that could match nothing', () => {
    expect(bulkStopRequest(family(), 'stranger', 'label', 4)).toBeNull();
  });

  test('honours a caller-supplied target list rather than re-deriving it', () => {
    const sessions = family();
    const request = bulkStopRequest(sessions, 'lead', 'cascade', 5, [sessions[1]!]);
    expect(request?.targets.map(view => view.config.id)).toEqual(['kid']);
  });
});

describe('runBulkStop', () => {
  const requestFor = (sessions: readonly SessionView[], scope: BulkStopRequest['scope'] = 'cascade') =>
    bulkStopRequest(sessions, 'lead', scope, 1)!;

  test('stops every confirmed target and names it in the outcome', async () => {
    const sessions = family();
    const { deps: dependencies, recorded } = deps([sessions, sessions]);
    const result = await runBulkStop(dependencies, requestFor(sessions));

    expect(result.running).toBe(false);
    expect(recorded.stopped.sort()).toEqual(['grandkid', 'kid', 'lead']);
    expect(result.outcomes?.every(outcome => outcome.ok)).toBe(true);
    expect(recorded.reasons.every(reason => reason.includes('lead'))).toBe(true);
  });

  test('stops nothing when the fleet could not be re-read', async () => {
    const sessions = family();
    const { deps: dependencies, recorded } = deps([new Error('daemon unreachable')]);
    const result = await runBulkStop(dependencies, requestFor(sessions));

    expect(recorded.stopped).toEqual([]);
    expect(result.outcomes).toEqual([
      { id: 'refresh-failed', name: 'Fleet refresh', ok: false, detail: 'daemon unreachable' },
    ]);
  });

  test('reports a confirmed target that stopped being eligible instead of dropping it', async () => {
    const sessions = family();
    const request = requestFor(sessions);
    // `kid` finished on its own while the dialog was open.
    const afterwards = sessions.map(view =>
      view.config.id === 'kid' ? running('kid', { config: { parent: 'lead' }, state: { status: 'completed' } }) : view,
    );
    const { deps: dependencies, recorded } = deps([afterwards, afterwards]);
    const result = await runBulkStop(dependencies, request);

    expect(recorded.stopped).not.toContain('kid');
    const ineligible = result.outcomes?.find(outcome => outcome.id === 'kid');
    expect(ineligible?.ok).toBe(false);
    expect(ineligible?.detail).toBe('No longer eligible after refresh; not stopped');
  });

  test('records a failed stop against the session it failed on', async () => {
    const sessions = family();
    const { deps: dependencies } = deps([sessions, sessions], id =>
      id === 'kid' ? new Error('pane already gone') : running(id, { state: { status: 'stopped' } }),
    );
    const result = await runBulkStop(dependencies, requestFor(sessions));
    const failed = result.outcomes?.find(outcome => outcome.id === 'kid');
    expect(failed?.ok).toBe(false);
    expect(failed?.detail).toBe('pane already gone');
  });

  test('reports a session that started matching mid-dialog rather than sweeping it in', async () => {
    const sessions = family();
    const request = bulkStopRequest(sessions, 'lead', 'children', 1)!;
    expect(request.targets.map(view => view.config.id).sort()).toEqual(['grandkid', 'kid']);

    const latecomer = running('newcomer', { config: { parent: 'lead' } });
    const after = [...sessions, latecomer];
    const { deps: dependencies, recorded } = deps([after, after]);
    const result = await runBulkStop(dependencies, request);

    expect(recorded.stopped.sort()).toEqual(['grandkid', 'kid']);
    expect(result.newTargets?.map(view => view.config.id)).toEqual(['newcomer']);
  });

  test('reports only the NEWLY orphaned descendants of an orphan sweep', async () => {
    const sessions = family();
    const request = bulkStopRequest(sessions, 'lead', 'orphan', 1)!;
    const latecomer = running('newcomer', { config: { parent: 'lead' } });
    const after = [...sessions, latecomer];
    const { deps: dependencies } = deps([after, after]);
    const result = await runBulkStop(dependencies, request);

    expect(result.newOrphanedDescendants?.map(view => view.config.id)).toEqual(['newcomer']);
    expect(result.newTargets).toEqual([]);
  });

  test('reports a failed re-scan without pretending the stops did not happen', async () => {
    const sessions = family();
    const { deps: dependencies, recorded } = deps([sessions, new Error('re-scan refused')]);
    const result = await runBulkStop(dependencies, requestFor(sessions));

    expect(recorded.stopped.length).toBe(3);
    expect(result.outcomes?.at(-1)).toEqual({
      id: 'rescan-failed',
      name: 'Fleet re-scan',
      ok: false,
      detail: 're-scan refused',
    });
  });

  test('feeds every fresh view back into the daemon’s fleet', async () => {
    const sessions = family();
    const { deps: dependencies, recorded } = deps([sessions, sessions]);
    await runBulkStop(dependencies, requestFor(sessions));
    expect(recorded.upserted).toContain('stranger');
    expect(recorded.upserted.filter(id => id === 'lead').length).toBeGreaterThan(1);
  });

  test('stringifies a non-Error refresh rejection rather than showing [object Object]', async () => {
    const sessions = family();
    const api: BulkStopApi<'alpha'> = {
      listSessions: () => Promise.reject('daemon said no'),
      stop: async () => sessions[0]!,
    };
    const result = await runBulkStop({ api, daemon: 'alpha', onUpsert: () => undefined }, requestFor(sessions));
    expect(result.outcomes?.[0]?.detail).toBe('daemon said no');
  });
});
