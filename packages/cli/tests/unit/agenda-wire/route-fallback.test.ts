import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { z } from 'zod';
import { requestWithRouteFallback, type WireApiClient } from '../../../src/lib/agenda-wire/route-fallback';
import { ProtocolAttentionGateway } from '../../../src/lib/attention/gateway';
import { ProtocolNotifyGateway } from '../../../src/lib/notify/gateway';
import { composeNoticeRequest } from '../../../src/lib/notify/request';
import { snapshot } from '../attention/fixtures';

const ROUTES = { current: '/v1/x/agenda', legacy: '/v1/x/attention' };
const Reply = z.object({ ok: z.literal(true) });

const unknownRoute = (): FyHttpError => new FyHttpError('no such route', 404, 'unknown_route');

/** A daemon: answers each path with the given outcome, recording every dial. */
function daemon(
  answers: Record<string, () => unknown>,
  dialed: string[] = [],
): { client: WireApiClient; dialed: string[] } {
  const client: WireApiClient = {
    request: <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
      dialed.push(path);
      try {
        return Promise.resolve(schema.parse(answers[path]?.()));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { client, dialed };
}

const refuse = (error: Error) => (): never => {
  throw error;
};

describe('request with route fallback', () => {
  it('should dial only the agenda route when the daemon knows it', async () => {
    // Arrange
    const { client, dialed } = daemon({ [ROUTES.current]: () => ({ ok: true }) });

    // Act
    await requestWithRouteFallback(client, ROUTES, Reply);
    await requestWithRouteFallback(client, ROUTES, Reply);

    // Assert
    should(dialed).deepEqual([ROUTES.current, ROUTES.current]);
  });

  it('should retry the older route once on unknown_route and then dial it directly for the rest of the process', async () => {
    // Arrange
    const { client, dialed } = daemon({
      [ROUTES.current]: refuse(unknownRoute()),
      [ROUTES.legacy]: () => ({ ok: true }),
    });

    // Act
    const first = await requestWithRouteFallback(client, ROUTES, Reply);
    const second = await requestWithRouteFallback(client, ROUTES, Reply);

    // Assert
    should(first).deepEqual({ ok: true });
    should(second).deepEqual({ ok: true });
    should(dialed).deepEqual([ROUTES.current, ROUTES.legacy, ROUTES.legacy]);
  });

  it('should keep the memory per client, so another daemon is asked the agenda route first', async () => {
    // Arrange
    const older = daemon({ [ROUTES.current]: refuse(unknownRoute()), [ROUTES.legacy]: () => ({ ok: true }) });
    const newer = daemon({ [ROUTES.current]: () => ({ ok: true }) });
    await requestWithRouteFallback(older.client, ROUTES, Reply);

    // Act
    await requestWithRouteFallback(newer.client, ROUTES, Reply);

    // Assert
    should(newer.dialed).deepEqual([ROUTES.current]);
  });

  it('should surface the older route failure without a third dial', async () => {
    // Arrange
    const { client, dialed } = daemon({
      [ROUTES.current]: refuse(unknownRoute()),
      [ROUTES.legacy]: refuse(new FyHttpError('boom', 500, undefined)),
    });

    // Act
    const actual = await requestWithRouteFallback(client, ROUTES, Reply).catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(FyHttpError);
    should(dialed).deepEqual([ROUTES.current, ROUTES.legacy]);
  });

  it.each([
    ['a handler 404 with another code', new FyHttpError('no such session', 404, 'not_found')],
    ['a 404 with no code', new FyHttpError('missing', 404, undefined)],
    ['a 5xx', new FyHttpError('down', 503, undefined)],
    ['an unknown_route code that is not a 404', new FyHttpError('odd', 400, 'unknown_route')],
    ['a transport failure', new Error('connection refused')],
  ])('should not fall back on %s', async (_name, error) => {
    // Arrange
    const { client, dialed } = daemon({ [ROUTES.current]: refuse(error), [ROUTES.legacy]: () => ({ ok: true }) });

    // Act
    const actual = await requestWithRouteFallback(client, ROUTES, Reply).catch((caught: unknown) => caught);
    await requestWithRouteFallback(client, ROUTES, Reply).catch(() => undefined);

    // Assert
    should(actual).equal(error);
    should(dialed).deepEqual([ROUTES.current, ROUTES.current]);
  });
});

describe('the agenda gateways against an older daemon', () => {
  const SESSION = 'ferret-1';
  const answers = {
    [`/v1/sessions/${SESSION}/agenda`]: refuse(unknownRoute()),
    [`/v1/sessions/${SESSION}/agenda/replies`]: refuse(unknownRoute()),
    [`/v1/sessions/${SESSION}/attention`]: () => snapshot([]),
    [`/v1/sessions/${SESSION}/attention/replies`]: () => snapshot([]),
  };

  it('should read, post, send replies and raise a notice over the older routes, sharing one memory per client', async () => {
    // Arrange
    const { client, dialed } = daemon(answers);
    const attention = new ProtocolAttentionGateway(client, SESSION);
    const notify = new ProtocolNotifyGateway(client, SESSION);

    // Act
    await attention.snapshot(SESSION);
    await attention.apply(SESSION, { action: 'dismiss', id: 'A1', note: 'stale' });
    await attention.sendReplies(SESSION);
    await notify.raise(SESSION, composeNoticeRequest(['PR', 'ready'], {}));

    // Assert
    should(dialed).deepEqual([
      `/v1/sessions/${SESSION}/agenda`,
      `/v1/sessions/${SESSION}/attention`,
      `/v1/sessions/${SESSION}/attention`,
      `/v1/sessions/${SESSION}/attention/replies`,
      `/v1/sessions/${SESSION}/attention`,
    ]);
  });
});
