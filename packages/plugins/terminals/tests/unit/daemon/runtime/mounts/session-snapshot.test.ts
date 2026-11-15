import { describe, expect, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import {
  type PaneSnapshotSource,
  type SnapshotExtent,
  type SnapshotFerrets,
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

  it('passes scope=screen and accepts live=true', async () => {
    const pane = source('x');
    await snapshotRoute(
      call({
        query: [
          ['scope', 'screen'],
          ['live', 'true'],
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

/** A ferret directory whose stored last screen is `kept`; it refuses a caller other than the ferret itself, as `mayTouch`. */
const withStored = (kept: string | undefined) => {
  const reads: { readonly ferret: string; readonly caller: string | undefined }[] = [];
  const directory: SnapshotFerrets = {
    ...ferretDirectory(),
    lastSnapshot: async (ferret, caller) => {
      reads.push({ ferret, caller });
      if (caller !== undefined && caller !== ferret)
        throw new ApiError(403, 'a ferret acts only on itself and its helpers', 'forbidden');
      return kept;
    },
  };
  return { directory, reads };
};

/** One admitted call made by the ferret `ferret` (its own token), as Gate's standing carries it. */
const ferretCall = (ferret: string, init: Parameters<typeof call>[0] = {}) =>
  ({ ...call(init), credential: { tokenClass: 'ferret', ferret } }) as unknown as ReturnType<typeof call>;

describe('GET /v1/ferrets/:ferretId/snapshot, a stopped ferret’s last screen (C58-15)', () => {
  const STORED = '$ env\nTOKEN=*****\n> ';

  it('C58-15 live=false answers the stored last screen and captures nothing live', async () => {
    const pane = source('LIVE');
    const { directory, reads } = withStored(STORED);

    const response = await snapshotRoute(call({ query: [['live', 'false']] }), directory, pane);

    expect(response.status).toBe(200);
    expect(String(response.body)).toBe(STORED);
    expect(pane.asked).toEqual([]);
    expect(reads).toEqual([{ ferret: 's1', caller: undefined }]);
  });

  it('C58-15 live=false with no stored screen is 409 stored_snapshot_unavailable, never an empty body', async () => {
    const error = await refusal(
      snapshotRoute(call({ query: [['live', 'false']] }), withStored(undefined).directory, source('LIVE')),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('stored_snapshot_unavailable');
  });

  it('C58-15 a ferret with no live pane falls back to its stored last screen', async () => {
    const pane = source(undefined);

    const response = await snapshotRoute(call(), withStored(STORED).directory, pane);

    expect(String(response.body)).toBe(STORED);
    expect(pane.asked).toEqual(['history']);
  });

  it('C58-15 a live pane is answered live: the stored screen is not read', async () => {
    const { directory, reads } = withStored(STORED);

    const response = await snapshotRoute(call(), directory, source('LIVE'));

    expect(String(response.body)).toBe('LIVE');
    expect(reads).toEqual([]);
  });

  it('C58-15 no live pane and no stored screen is still pane_dead', async () => {
    const error = await refusal(snapshotRoute(call(), withStored(undefined).directory, source(undefined)));

    expect(error.code).toBe('pane_dead');
  });

  it('C58-15 a Ferrets that offers no stored read answers as before: pane_dead, and stored_snapshot_unavailable', async () => {
    const dead = await refusal(snapshotRoute(call(), ferretDirectory(), source(undefined)));
    const stored = await refusal(snapshotRoute(call({ query: [['live', 'false']] }), ferretDirectory(), source('x')));

    expect([dead.code, stored.code]).toEqual(['pane_dead', 'stored_snapshot_unavailable']);
  });

  it('C58-15 the caller behind the call is handed to the stored read: a ferret reads its own, and a stranger gets nothing', async () => {
    const { directory, reads } = withStored(STORED);

    const own = await snapshotRoute(ferretCall('s1', { query: [['live', 'false']] }), directory, source('LIVE'));
    const stranger = await refusal(
      snapshotRoute(ferretCall('s2', { query: [['live', 'false']] }), directory, source('LIVE')),
    );
    const strangerNoPane = await refusal(snapshotRoute(ferretCall('s2'), directory, source(undefined)));

    expect(String(own.body)).toBe(STORED);
    expect([stranger.status, stranger.code]).toEqual([403, 'forbidden']);
    expect([strangerNoPane.status, strangerNoPane.code]).toEqual([403, 'forbidden']);
    expect(reads.map(read => read.caller)).toEqual(['s1', 's2', 's2']);
  });
});
