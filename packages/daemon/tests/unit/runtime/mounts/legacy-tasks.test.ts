import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { FleetTaskListResponseSchema, SessionTaskListResponseSchema } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { legacyTaskRoutes } from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { AT, CREDENTIALS, human } from './support.ts';

const dispatch = async (path: string, method = 'GET') => {
  const routes = legacyTaskRoutes({ now: () => AT });
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
  return await dispatcher.dispatch(request({ method, path, headers: human }));
};

describe('legacy task list reads', () => {
  it("should answer an older client's session read with a schema-valid empty list", async () => {
    // Act
    const response = await dispatch('/v1/sessions/s1/tasks');

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(SessionTaskListResponseSchema.parse(jsonBody(response))).deepEqual({
      v: 1,
      sessionId: 's1',
      tasks: [],
      parseErrors: 0,
      updatedAt: AT,
    });
  });

  it("should answer an older client's fleet read with a schema-valid empty list", async () => {
    // Act
    const response = await dispatch('/v1/tasks');

    // Assert
    should(response.status).equal(200);
    should(FleetTaskListResponseSchema.parse(jsonBody(response))).deepEqual({
      v: 1,
      sessionId: null,
      tasks: [],
      parseErrors: 0,
      updatedAt: AT,
    });
  });

  it('should refuse a path session id that decodes to a traversal step', async () => {
    // Act
    const response = await dispatch('/v1/sessions/%2e%2e/tasks');

    // Assert
    should(response.status).equal(400);
  });

  it('should no longer serve any write or per-task read', async () => {
    // Act / Assert
    should((await dispatch('/v1/sessions/s1/tasks', 'POST')).status).be.aboveOrEqual(400);
    should((await dispatch('/v1/sessions/s1/tasks/F1')).status).equal(404);
    should((await dispatch('/v1/sessions/s1/tasks/F1', 'POST')).status).be.aboveOrEqual(400);
  });
});
