import { describe, it } from 'bun:test';
import type { ConfigChangeKind } from '@ferretry/protocol';
import should from 'should';
import { jsonResponse } from '../../../src/lib/api/responses.ts';
import type { ApiRoute, RouteContext } from '../../../src/lib/api/route.ts';
import { ANNOUNCED_ROUTES, configAnnouncedRoutes } from '../../../src/lib/config-files/index.ts';

const answering = (method: ApiRoute['method'], path: string, status: number): ApiRoute => ({
  method,
  path,
  minimum: 'operator',
  caller: 'any',
  handle: async () => jsonResponse({ ok: status < 300 }, status),
});

const decorate = (routes: readonly ApiRoute[]) => {
  const announced: (readonly ConfigChangeKind[])[] = [];
  return { announced, routes: configAnnouncedRoutes({ announce: kinds => announced.push(kinds) }, routes) };
};

const call = async (route: ApiRoute | undefined): Promise<number> =>
  (await (route as ApiRoute).handle({} as RouteContext)).status;

describe('configAnnouncedRoutes', () => {
  it('should announce the listed kinds once a listed route has answered with success', async () => {
    // Arrange
    const { announced, routes } = decorate([answering('POST', '/v1/fleet/credentials/:credentialId/check', 200)]);

    // Act
    const status = await call(routes[0]);

    // Assert — Check now moved the status word every runtime on the login reads.
    should(status).equal(200);
    should(announced).deepEqual([['credentials', 'runtimes']]);
  });

  it('should announce nothing for a refused change', async () => {
    // Arrange
    const { announced, routes } = decorate([answering('POST', '/v1/speedups/:provider/test', 409)]);

    // Act
    const status = await call(routes[0]);

    // Assert
    should(status).equal(409);
    should(announced).be.empty();
  });

  it('should leave an unlisted route untouched, and match the method as well as the path', () => {
    // Arrange
    const read = answering('GET', '/v1/fleet/credentials', 200);
    const listedPathOtherMethod = answering('GET', '/v1/fleet/mcp-auth/:component', 200);

    // Act
    const { routes } = decorate([read, listedPathOtherMethod]);

    // Assert
    should(routes[0]).equal(read);
    should(routes[1]).equal(listedPathOtherMethod);
  });

  it('should list only changes, each naming at least one kind', () => {
    // Assert — a read that announced would make every reader refetch on every read.
    for (const rule of ANNOUNCED_ROUTES) {
      should(rule.method).not.equal('GET');
      should(rule.kinds.length).be.above(0);
    }
  });
});
