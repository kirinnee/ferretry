import { describe, it } from 'bun:test';
import { ApiError, type ApiResponse } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import type { ModelListRefreshResult } from '../../../contract/model-list.ts';
import { FleetCredentialRefusal } from '../../../daemon/lib/credentials/credentials-service.ts';
import { modelListRoutes } from '../../../daemon/lib/routes/model-lists.ts';
import { call } from '../../support/call-route.ts';

const PATH = 'POST /v1/logins/:loginId/model-list/refresh';
const LIST = { fetchedAt: '2026-11-23T00:00:00.000Z' as Instant, complete: true, ids: ['deepseek-chat'] };
const json = (response: ApiResponse): unknown => JSON.parse(String((response as { body: unknown }).body));

describe('modelListRoutes', () => {
  it('should refresh one login’s list, asking for a forced read only when the body says force', async () => {
    // Arrange
    const asked: { id: string; force: boolean }[] = [];
    const routes = modelListRoutes({
      refresh: async (id, options) => {
        asked.push({ id, force: options.force });
        return { loginId: id, outcome: 'refreshed', list: LIST } as unknown as ModelListRefreshResult;
      },
    });

    // Act
    const plain = await call(routes, PATH, { path: '/v1/logins/deepseek/model-list/refresh', body: {} });
    const forced = await call(routes, PATH, { path: '/v1/logins/deepseek/model-list/refresh', body: { force: true } });

    // Assert
    should(plain.status).equal(200);
    should(json(plain)).eql({ loginId: 'deepseek', outcome: 'refreshed', list: LIST });
    should(asked).eql([
      { id: 'deepseek', force: false },
      { id: 'deepseek', force: true },
    ]);
    should(forced.status).equal(200);
  });

  it('should refuse a body with a field it does not know, and a login this machine does not have', async () => {
    // Arrange
    const routes = modelListRoutes({
      refresh: async id => {
        throw new FleetCredentialRefusal('fleet_credential_unknown', `no login "${id}" exists on this machine`);
      },
    });
    const failure = async (path: string, body: unknown): Promise<unknown> => {
      try {
        await call(routes, PATH, { path, body });
      } catch (error) {
        return error;
      }
      return undefined;
    };

    // Act
    const strange = await failure('/v1/logins/x/model-list/refresh', { force: true, key: 'sk-nope' });
    const unknown = await failure('/v1/logins/nobody/model-list/refresh', {});

    // Assert
    should(strange).be.instanceOf(ApiError);
    should(strange).containDeep({ status: 400 });
    should(String((strange as Error).message)).not.containEql('sk-nope');
    should(unknown).containDeep({ status: 404, code: 'fleet_credential_unknown' });
  });
});
