import { describe, expect, test } from 'bun:test';
import type { ApiResponse, FerretId } from '@ferretry/kernel/contract';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { HARNESS_UPDATE_CODES } from '../../contract/index.ts';
import { codexUpdateRoutes } from '../../daemon/lib/routes.ts';
import { HarnessUpdateRefusal, type HarnessUpdateSubsystem } from '../../daemon/lib/update/service.ts';

const VIEW = { harness: 'codex' } as never;

const call = (body: unknown, standing: object = {}) =>
  ({ request: { text: async () => JSON.stringify(body) }, params: new Map(), ...standing }) as never;

const answer = (response: ApiResponse): { status: number; json: Record<string, unknown> } => ({
  status: response.status,
  json: JSON.parse(response.body) as Record<string, unknown>,
});

const refused = async (promise: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  (await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )) as { status: number; code?: string };

/** A subsystem that counts the updates it was asked to start, or refuses every one. */
function subsystem(refusal?: HarnessUpdateRefusal): HarnessUpdateSubsystem & { started: number } {
  const fake = {
    started: 0,
    view: async () => VIEW,
    start: async () => {
      if (refusal !== undefined) throw refusal;
      fake.started += 1;
      return VIEW;
    },
  };
  return fake;
}

/**
 * A remote device as Gate admits it: governed, holding a fresh passkey proof until a route spends it. Each request reads
 * the standing again, as Gate stamps a new one per call, so a spent proof is gone on the next.
 */
function remoteDevice(fresh: boolean) {
  const state = { fresh, spent: 0 };
  const standing = () => ({
    ...deviceStanding('phone'),
    governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
    presentation: { local: false, adminToken: false, actor: 'device:phone', stepUp: false, freshStepUp: state.fresh },
    spendFreshStepUp: () => {
      state.spent += 1;
      state.fresh = false;
    },
  });
  return { state, standing };
}

const start = (fake: HarnessUpdateSubsystem) => codexUpdateRoutes(fake)['POST /v1/codex/update'];

describe('starting a Codex update is the owner’s act (G25)', () => {
  test('G25 a ferret is refused 403 and no update starts', async () => {
    const fake = subsystem();

    const error = await refused(start(fake)(call({}, ferretStanding('F1' as FerretId))));

    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
    expect(fake.started).toBe(0);
  });

  test('G25 a remote device without a fresh passkey is asked for one (fleet.configure) and no update starts', async () => {
    const fake = subsystem();

    const response = answer(await start(fake)(call({}, remoteDevice(false).standing())));

    expect(response).toEqual({
      status: 403,
      json: {
        error: 'to update the agent CLIs on this machine from this device, confirm with a passkey',
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'fleet', axis: 'configure' },
      },
    });
    expect(fake.started).toBe(0);
  });

  test('G25 with a fresh passkey the update starts and the proof is spent, so the next call is asked again', async () => {
    const fake = subsystem();
    const phone = remoteDevice(true);

    const first = answer(await start(fake)(call({}, phone.standing())));
    const second = answer(await start(fake)(call({}, phone.standing())));

    expect([first.status, second.status, second.json.code, fake.started, phone.state.spent]).toEqual([
      202,
      403,
      STEP_UP_REQUIRED_CODE,
      1,
      1,
    ]);
  });

  test('G25 the owner at the machine starts an update with no passkey, and nothing is spent', async () => {
    const fake = subsystem();
    let spent = 0;

    const response = answer(
      await start(fake)(
        call(
          {},
          {
            ...ownerStanding(),
            spendFreshStepUp: () => {
              spent += 1;
            },
          },
        ),
      ),
    );

    expect([response.status, fake.started, spent]).toEqual([202, 1, 0]);
  });

  test('G25 a refused update does not spend the passkey proof', async () => {
    const fake = subsystem(new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.inProgress, 'busy'));
    const phone = remoteDevice(true);

    const error = await refused(start(fake)(call({}, phone.standing())));

    expect([error.status, error.code, phone.state.spent]).toEqual([409, HARNESS_UPDATE_CODES.inProgress, 0]);
  });

  test('G25 the unverified refusal is an answer carrying both versions, and spends nothing', async () => {
    const fake = subsystem(
      new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.unverified, 'not verified', {
        target: '0.200.0',
        verified: '0.190.0',
      }),
    );
    const phone = remoteDevice(true);

    const response = answer(await start(fake)(call({}, phone.standing())));

    expect([
      response.status,
      response.json.code,
      response.json.target,
      response.json.verified,
      phone.state.spent,
    ]).toEqual([409, HARNESS_UPDATE_CODES.unverified, '0.200.0', '0.190.0', 0]);
  });
});
