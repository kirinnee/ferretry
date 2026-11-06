import { describe, it } from 'bun:test';
import { TIDY_PLAN_PATH, type TidyPlan } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type TidySubsystem, tidyRoutes } from '../../../../src/lib/runtime/mounts/tidy.ts';
import type { TidyPlanResult } from '../../../../src/lib/tidy/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FERRET_SESSION, fromFerret, grantSubsystem, human } from './support.ts';

const phone = { deviceId: 'fy_device_id_phone', appSession: 'app-one' } as const;
const MEMBER = { memberId: 'mbr_x', keyId: 'mk_x', appSession: 'app-one', sessionId: 'relay-1' } as const;

const planFor = (sessionId: string): TidyPlan => ({
  v: 1,
  sessionId,
  subFerret: false,
  drop: [{ id: 'F1', title: 'A card', why: 'because' }],
  close: [],
  keep: [],
});

/** A tidy that records which session each plan was asked for. */
const recording = (result?: (sessionId: string) => TidyPlanResult) => {
  const asked: string[] = [];
  const tidy: TidySubsystem = {
    plan: async sessionId => {
      asked.push(sessionId);
      return result?.(sessionId) ?? { ok: true, plan: planFor(sessionId) };
    },
  };
  return { asked, tidy };
};

async function dispatcher(tidy: TidySubsystem, fleet = DEFAULT_CAPABILITY_GRANTS.fleet): Promise<ApiDispatcher> {
  const grants = grantSubsystem({ grants: { ...DEFAULT_CAPABILITY_GRANTS, fleet } });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(tidyRoutes(tidy)), CREDENTIALS, grants, undefined, {
    held: device => device.deviceId === phone.deviceId,
  });
}

const post = (extra: Record<string, unknown> = {}) => request({ method: 'POST', path: TIDY_PLAN_PATH, ...extra });

describe('POST /v1/tidy/plan', () => {
  it('should plan the calling ferret’s own work, named by its session header', async () => {
    // Arrange
    const { asked, tidy } = recording();

    // Act
    const response = await (await dispatcher(tidy)).dispatch(post({ headers: agentIn('lead') }));

    // Assert
    should(response.status).equal(200);
    should(asked).eql(['lead']);
    should(jsonBody(response)).eql(planFor('lead'));
  });

  it('should name the session from the ferret’s own credential, never from the body', async () => {
    // Arrange
    const { asked, tidy } = recording();

    // Act
    const response = await (await dispatcher(tidy)).dispatch(
      fromFerret(post({ headers: human, body: JSON.stringify({ sessionId: 'someone-else' }) })),
    );

    // Assert
    should(response.status).equal(200);
    should(asked).eql([FERRET_SESSION]);
  });

  it('should refuse the owner at the machine, who has no work of their own to tidy', async () => {
    // Arrange
    const { asked, tidy } = recording();

    // Act
    const response = await (await dispatcher(tidy)).dispatch(post({ headers: human }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).containDeep({ code: 'forbidden' });
    should(asked).eql([]);
  });

  it('should refuse a paired device, which is the owner', async () => {
    // Arrange
    const { asked, tidy } = recording();

    // Act
    const response = await (await dispatcher(tidy)).dispatch(post({ device: phone }));

    // Assert
    should(response.status).equal(403);
    should(asked).eql([]);
  });

  it('should keep a ferret out when the fleet grant is closed', async () => {
    // Arrange
    const { asked, tidy } = recording();
    const closed = await dispatcher(tidy, { use: false, configure: false });

    // Act
    const response = await closed.dispatch(post({ device: phone }));

    // Assert
    should(response.status).equal(403);
    should(asked).eql([]);
  });

  it('should give a shared-catalog member nothing, even over loopback', async () => {
    // Arrange
    const { asked, tidy } = recording();
    const open = await dispatcher(tidy);

    // Act
    const answers = await Promise.all(
      [{ headers: agentIn('lead') }, { loopback: true, privilegedLoopback: true }].map(carried =>
        open.dispatch({ ...post(carried), member: MEMBER }),
      ),
    );

    // Assert
    should(answers.map(answer => answer.status)).eql([403, 403]);
    should(asked).eql([]);
  });

  it('should refuse a caller with no credential', async () => {
    // Arrange
    const { asked, tidy } = recording();

    // Act
    const response = await (await dispatcher(tidy)).dispatch(post());

    // Assert
    should(response.status).equal(401);
    should(asked).eql([]);
  });

  it('should answer 503 when the facts cannot be read, without the thrown text', async () => {
    // Arrange
    const { tidy } = recording(() => ({ ok: false, message: 'the agenda is unreadable' }));

    // Act
    const response = await (await dispatcher(tidy)).dispatch(post({ headers: agentIn('lead') }));

    // Assert
    should(response.status).equal(503);
    should(jsonBody(response)).containDeep({ code: 'unavailable' });
  });
});
