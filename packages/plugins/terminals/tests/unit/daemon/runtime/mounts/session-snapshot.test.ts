import { describe, expect, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import {
  type PaneSnapshotSource,
  type SnapshotExtent,
  snapshotRoute,
} from '../../../../../daemon/lib/runtime/mounts/session-snapshot.ts';
import { call, ferretDirectory } from './processes-support.ts';

const source = (text: string | undefined): PaneSnapshotSource & { readonly asked: SnapshotExtent[] } => {
  const asked: SnapshotExtent[] = [];
  return {
    asked,
    capture: async (_ferret, extent) => {
      asked.push(extent);
      return text;
    },
  };
};

const refusal = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('GET /v1/ferrets/:ferretId/snapshot', () => {
  it('answers the pane as text, history by default', async () => {
    const pane = source('line one\nline two');
    const response = await snapshotRoute(call(), ferretDirectory(), pane);
    expect(response.status).toBe(200);
    expect(String(response.body)).toBe('line one\nline two');
    expect(pane.asked).toEqual(['history']);
  });

  it('passes scope=screen and accepts live=false', async () => {
    const pane = source('x');
    await snapshotRoute(
      call({
        query: [
          ['scope', 'screen'],
          ['live', 'false'],
        ],
      }),
      ferretDirectory(),
      pane,
    );
    expect(pane.asked).toEqual(['screen']);
  });

  it('refuses a bad query before touching the pane', async () => {
    const pane = source('x');
    expect((await refusal(snapshotRoute(call({ query: [['live', 'maybe']] }), ferretDirectory(), pane))).status).toBe(
      400,
    );
    expect((await refusal(snapshotRoute(call({ query: [['scope', 'all']] }), ferretDirectory(), pane))).status).toBe(
      400,
    );
    expect(pane.asked).toEqual([]);
  });

  it('answers 404 for a ferret this daemon does not hold', async () => {
    const pane = source('x');
    expect((await refusal(snapshotRoute(call({ params: { ferretId: 'nope' } }), ferretDirectory(), pane))).status).toBe(
      404,
    );
    expect(pane.asked).toEqual([]);
  });

  it('reports a pane that is gone as gone, never as an empty screen', async () => {
    const error = await refusal(snapshotRoute(call(), ferretDirectory(), source(undefined)));
    expect(error.status).toBe(409);
    expect(error.code).toBe('pane_dead');
  });
});
