import { describe, expect, test } from 'bun:test';
import { ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import {
  ApiError,
  type CallContext,
  type CallStanding,
  type CarrierKey,
  type FerretId,
} from '@ferretry/kernel/contract';
import { wardenRoutes } from '../../../daemon/routes.ts';
import type { WardenSubsystem } from '../../../daemon/subsystem.ts';

const unreached = (): never => {
  throw new Error('not reached by a run');
};

/** The subsystem behind the routes, recording the `spawn` of each run it is asked for. */
function recordingSubsystem(): { readonly subsystem: WardenSubsystem; readonly runs: boolean[] } {
  const runs: boolean[] = [];
  const subsystem: WardenSubsystem = {
    run: async spawn => {
      runs.push(spawn);
      return { sweptAt: '2026-11-07T12:00:00.000Z', anomalies: [] };
    },
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
  return { subsystem, runs };
}

/** `POST /v1/warden/run` as Gate hands it to the handler AFTER admission: the standing already met `operator`. */
const runCall = (standing: CallStanding, body?: unknown): CallContext => ({
  request: {
    method: 'POST',
    path: '/v1/warden/run',
    query: new Map(),
    headers: new Map([['content-type', 'application/json']]),
    arrival: { kind: 'carried', carrier: 'direct' as CarrierKey },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  },
  params: new Map(),
  ...standing,
});

describe('R-0408 the run handler', () => {
  test('R-0408 a ferret admitted at operator is refused a run that starts investigators, 403 owner_only', async () => {
    const { subsystem, runs } = recordingSubsystem();
    const run = wardenRoutes(subsystem, { mayTouch: () => true })['POST /v1/warden/run'];

    const refused = await run(runCall(ferretStanding('f1' as FerretId), { spawn: true })).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      status: 403,
      code: 'owner_only',
      message: 'a ferret cannot start Warden investigators; ask the owner',
    });
    expect(runs).toEqual([]);
  });

  test('R-0408 a ferret may still ask for a sweep that only looks (spawn false, or no body)', async () => {
    const { subsystem, runs } = recordingSubsystem();
    const run = wardenRoutes(subsystem, { mayTouch: () => true })['POST /v1/warden/run'];

    const looked = await run(runCall(ferretStanding('f1' as FerretId), { spawn: false }));
    const bare = await run(runCall(ferretStanding('f1' as FerretId)));

    expect(looked.status).toBe(200);
    expect(bare.status).toBe(200);
    expect(runs).toEqual([false, false]);
  });

  test('R-0408 the owner may run a sweep that starts investigators', async () => {
    const { subsystem, runs } = recordingSubsystem();
    const run = wardenRoutes(subsystem, { mayTouch: () => true })['POST /v1/warden/run'];

    const answered = await run(runCall(ownerStanding(), { spawn: true }));

    expect(answered.status).toBe(200);
    expect(runs).toEqual([true]);
  });
});
