import { describe, expect, test } from 'bun:test';
import { type ApiResponse, BodyTooLargeError, type FerretId } from '@ferretry/kernel/contract';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { HARNESS_UPDATE_CODES } from '../../contract/index.ts';
import { codexUpdateRoutes } from '../../daemon/lib/routes.ts';
import { HarnessUpdateRefusal, type HarnessUpdateSubsystem } from '../../daemon/lib/update/service.ts';

const VIEW = { harness: 'codex' } as never;

const call = (body: unknown, standing: object = {}) =>
  ({ request: { text: async () => JSON.stringify(body) }, params: new Map(), ...standing }) as never;

/** A call carrying exactly `text`, read the way every arrival reads one: over the route's bound is a 413. */
const rawCall = (text: string) =>
  ({
    request: {
      text: async (limit?: number) => {
        if (limit !== undefined && new TextEncoder().encode(text).byteLength > limit)
          throw new BodyTooLargeError(limit);
        return text;
      },
    },
    params: new Map(),
  }) as never;

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
 * A remote device as Gate admits it: governed, holding a fresh passkey proof until a route claims it. Each request
 * reads the standing again, as Gate stamps a new one per call — and `freshStepUp` is that admission's SNAPSHOT, so two
 * standings taken before either request runs both say fresh. The claim is atomic, as Access's is. `spent` counts every
 * claim and every spend, so a route that took the proof twice would show 2.
 */
function remoteDevice(fresh: boolean) {
  const state = { fresh, spent: 0 };
  const standing = () => ({
    ...deviceStanding('phone'),
    governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
    presentation: { local: false, adminToken: false, actor: 'device:phone', stepUp: false, freshStepUp: state.fresh },
    claimFreshStepUp: () => {
      if (!state.fresh) return false;
      state.fresh = false;
      state.spent += 1;
      return true;
    },
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
            claimFreshStepUp: () => {
              spent += 1;
              return true;
            },
            spendFreshStepUp: () => {
              spent += 1;
            },
          },
        ),
      ),
    );

    expect([response.status, fake.started, spent]).toEqual([202, 1, 0]);
  });

  test('G25 a refused update has used the proof up, so a retry with the same proof is refused', async () => {
    // Claim-first, no restore (today's claim-first routes): one proof admits one act, and the person confirms again.
    const fake = subsystem(new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.inProgress, 'busy'));
    const phone = remoteDevice(true);

    const error = await refused(start(fake)(call({}, phone.standing())));
    const retry = answer(await start(fake)(call({}, phone.standing())));

    expect([error.status, error.code, phone.state.spent]).toEqual([409, HARNESS_UPDATE_CODES.inProgress, 1]);
    expect([retry.status, retry.json.code]).toEqual([403, STEP_UP_REQUIRED_CODE]);
  });

  test('G25 two requests racing on one fresh proof: exactly one update starts, the other is asked again', async () => {
    const fake = subsystem();
    const phone = remoteDevice(true);
    // Both standings are taken before either request runs: each admission saw the proof fresh.
    const [a, b] = [phone.standing(), phone.standing()];

    const answers = (await Promise.all([start(fake)(call({}, a)), start(fake)(call({}, b))])).map(answer);

    expect(answers.map(each => each.status).sort()).toEqual([202, 403]);
    expect(answers.find(each => each.status === 403)?.json.code).toBe(STEP_UP_REQUIRED_CODE);
    expect([fake.started, phone.state.spent]).toEqual([1, 1]);
  });

  test('G25 the unverified refusal is an answer carrying both versions, and has used the proof up', async () => {
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
    ]).toEqual([409, HARNESS_UPDATE_CODES.unverified, '0.200.0', '0.190.0', 1]);
  });
});

describe('the start body is read as today’s api/body.ts reads one', () => {
  test('over 4 KiB is 413 body_too_large, not JSON is 400 invalid_json, not the schema is 400 invalid_request', async () => {
    const fake = subsystem();
    const route = start(fake);

    expect(await refused(route(rawCall(JSON.stringify({ target: 'x'.repeat(5 * 1024) }))))).toMatchObject({
      status: 413,
      code: 'body_too_large',
    });
    expect(await refused(route(rawCall('not json')))).toMatchObject({ status: 400, code: 'invalid_json' });
    expect(await refused(route(rawCall('')))).toMatchObject({ status: 400, code: 'invalid_json' });
    expect(await refused(route(rawCall('{"target":"not-a-version"}')))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(fake.started).toBe(0);
  });
});
