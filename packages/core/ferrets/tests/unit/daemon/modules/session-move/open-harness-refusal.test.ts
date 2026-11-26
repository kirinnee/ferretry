import { describe, expect, test } from 'bun:test';
import { ownerStanding } from '@ferretry/core-gate/contract/testing';
import { ApiError } from '@ferretry/kernel/contract';
import { FY_REQUEST_ID_HEADER } from '../../../../../daemon/lib/protocol/headers.ts';
import { sessionMoveRoutes } from '../../../../../daemon/lib/runtime/mounts/session-move.ts';
import { sessionMoveModule } from '../../../../../daemon/modules/session-move.ts';
import { sessionView } from '../../../../support/daemon/session-view.ts';
import { requestOf } from '../../support/requests.ts';
import { sessionMoveNeedsForTest } from './fixture.ts';

/**
 * A session stamped for a harness this build cannot read (`fake-third`) is REFUSED by the move's preflight, on the
 * mounted routes, by name — and the refusal leaves the replay slot free.
 *
 * The routes here are the real module's: `sessionMoveRoutes` over the subsystem `sessionMoveModule.build` provides, with
 * ONE replay slot, so a refusal that kept its slot would turn the next request id into `move_ledger_full`.
 */

const THIRD = 'fake-third';
const owner = ownerStanding();

function mounted() {
  const view = sessionView('wren', { harness: THIRD });
  const tails: unknown[] = [];
  const inspections: unknown[] = [];
  const needs = sessionMoveNeedsForTest({
    storage: {
      findSession: () => ({}),
      readConfig: async () => view.config,
      readState: async () => view.state,
    } as never,
    restart: { record: () => ({ runtime: 'claude-auto', handle: 'pane-1' }) } as never,
    pane: () => ({}) as never,
    preflight: {
      inspect: async (...args: unknown[]) => void inspections.push(args),
    } as never,
    transcripts: {
      tail: async (...args: unknown[]) => void tails.push(args),
    } as never,
  });
  const routes = sessionMoveRoutes(sessionMoveModule.build(needs, undefined, undefined).provides, 1);
  const call = (path: string, requestId?: string) => {
    const route = routes.find(candidate => candidate.path === `/v1/ferrets/:ferretId${path}`);
    if (route === undefined) throw new Error(`no route ${path}`);
    return async () =>
      await route.handle(
        requestOf({
          method: 'POST',
          path: `/v1/ferrets/wren${path}`,
          params: { ferretId: 'wren' },
          headers: requestId === undefined ? {} : { [FY_REQUEST_ID_HEADER]: requestId },
          ...(path === '/move' ? { body: { agent: 'claude-auto' } } : {}),
          standing: owner,
        }),
      );
  };
  return { call, tails, inspections };
}

async function refusal(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('the route answered instead of refusing');
}

describe('a move of a session on a harness this build cannot read', () => {
  test('Restart is refused by name as a preflight refusal, not answered as a 500', async () => {
    const m = mounted();
    const answered = await refusal(m.call('/move', 'req-1'));

    expect([answered.status, answered.code]).toEqual([409, 'harness_mismatch']);
    expect(answered.message).toContain(THIRD);
    expect(m.tails).toEqual([]);
    expect(m.inspections).toEqual([]);
  });

  test('a fresh request id afterwards is refused the same way — the first refusal kept no replay slot', async () => {
    const m = mounted();
    await refusal(m.call('/move', 'req-1'));
    const again = await refusal(m.call('/move', 'req-2'));

    expect([again.status, again.code]).toEqual([409, 'harness_mismatch']);
    expect(m.tails).toEqual([]);
  });

  test('Ask to Stop Jobs is refused the same way', async () => {
    const m = mounted();
    const answered = await refusal(m.call('/move/ask-to-stop-jobs'));

    expect([answered.status, answered.code]).toEqual([409, 'harness_mismatch']);
    expect(answered.message).toContain(THIRD);
    expect(m.tails).toEqual([]);
  });
});
