import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import { ProjectInfoSchema, type RegisterProjectRequest } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiError, ApiRouter } from '../../../../src/lib/api/index.ts';
import { type CatalogSubsystem, catalogRoutes } from '../../../../src/lib/runtime/mounts/catalogs.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionDirectory } from './support.ts';

const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ferretry',
  path: '/work/ferretry',
  source: 'existing-folder' as const,
  createdAt: '2026-08-04T00:00:00.000Z',
};

const dispatcher = (catalogs: CatalogSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(catalogRoutes(catalogs, sessionDirectory())), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

describe('the project catalog mount', () => {
  it('registers an explicit folder and returns its wire record', async () => {
    const registered: RegisterProjectRequest[] = [];
    const response = await dispatcher({
      projects: async () => [],
      registerProject: async entry => {
        registered.push(entry);
        return PROJECT;
      },
      skills: async () => ({ harness: 'codex', skills: [] }),
    }).dispatch(
      request({
        method: 'POST',
        path: '/v1/projects',
        headers: human,
        body: JSON.stringify({ kind: 'existing-folder', path: '/work/ferretry', name: 'Ferretry' }),
      }),
    );

    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(ProjectInfoSchema.parse(jsonBody(response))).deepEqual(PROJECT);
    should(registered).deepEqual([{ kind: 'existing-folder', path: '/work/ferretry', name: 'Ferretry' }]);
  });

  it('keeps catalog errors explicit, preserving API errors and translating ordinary failures', async () => {
    let failure: Error = new ApiError(409, 'the folder is already registered', 'project_exists');
    const surface = dispatcher({
      projects: async () => [],
      registerProject: async () => {
        throw failure;
      },
      skills: async () => ({ harness: 'codex', skills: [] }),
    });
    const requestProject = () =>
      surface.dispatch(
        request({
          method: 'POST',
          path: '/v1/projects',
          headers: human,
          body: JSON.stringify({ kind: 'new-folder', path: '/work/new', initializeGit: true }),
        }),
      );

    const known = await requestProject();
    failure = new Error('the filesystem is read-only');
    const unexpected = await requestProject();

    should([known.status, unexpected.status]).deepEqual([409, 422]);
    should(jsonBody(known)).deepEqual({ error: 'the folder is already registered', code: 'project_exists' });
    should(jsonBody(unexpected)).deepEqual({
      error: 'the filesystem is read-only',
      code: 'project_registration_failed',
    });
  });
});
