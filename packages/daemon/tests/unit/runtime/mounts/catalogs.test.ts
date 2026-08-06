import { describe, it } from 'bun:test';
import { ProjectInfoSchema, type RegisterProjectRequest } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiError, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type CatalogSubsystem, catalogRoutes } from '../../../../src/lib/runtime/mounts/catalogs.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, grantSubsystem, human, sessionDirectory } from './support.ts';

const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ferretry',
  path: '/work/ferretry',
  source: 'existing-folder' as const,
  createdAt: '2026-08-04T00:00:00.000Z',
};

async function dispatcher(catalogs: CatalogSubsystem, configureFilesystem = true): Promise<ApiDispatcher> {
  const grants = grantSubsystem({
    grants: {
      ...DEFAULT_CAPABILITY_GRANTS,
      filesystem: { use: true, configure: configureFilesystem },
    },
  });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(catalogRoutes(catalogs, sessionDirectory())), CREDENTIALS, grants);
}

describe('the project catalog mount', () => {
  it('registers an explicit folder and returns its wire record', async () => {
    const registered: RegisterProjectRequest[] = [];
    const response = await (
      await dispatcher({
        projects: async () => [],
        registerProject: async entry => {
          registered.push(entry);
          return PROJECT;
        },
        skills: async () => ({ harness: 'codex', skills: [] }),
      })
    ).dispatch(
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

  it('keeps loopback registration available when the remote filesystem grant is disabled', async () => {
    const registered: RegisterProjectRequest[] = [];
    const surface = await dispatcher(
      {
        projects: async () => [],
        registerProject: async entry => {
          registered.push(entry);
          return PROJECT;
        },
        skills: async () => ({ harness: 'codex', skills: [] }),
      },
      false,
    );

    const response = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/projects',
        headers: human,
        loopback: true,
        body: JSON.stringify({ kind: 'existing-folder', path: '/work/ferretry' }),
      }),
    );

    should(response.status).equal(200);
    should(registered).deepEqual([{ kind: 'existing-folder', path: '/work/ferretry' }]);
  });

  it('refuses a remote registration before mutation when filesystem configuration is disabled', async () => {
    const registered: RegisterProjectRequest[] = [];
    const surface = await dispatcher(
      {
        projects: async () => [],
        registerProject: async entry => {
          registered.push(entry);
          return PROJECT;
        },
        skills: async () => ({ harness: 'codex', skills: [] }),
      },
      false,
    );

    const response = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/projects',
        headers: human,
        body: JSON.stringify({ kind: 'existing-folder', path: '/work/ferretry' }),
      }),
    );

    should(response.status).equal(403);
    should(jsonBody(response)).deepEqual({
      error:
        'the operator of this machine has not granted the UI permission to change the settings for session working trees. Grant it on the host with `fy daemon config set filesystem --configure`.',
      code: 'grant_not_granted',
    });
    should(registered).be.empty();
  });

  it('leaves the remote project read route ungoverned by the filesystem grant', async () => {
    let reads = 0;
    const surface = await dispatcher(
      {
        projects: async () => {
          reads += 1;
          return [PROJECT];
        },
        registerProject: async () => PROJECT,
        skills: async () => ({ harness: 'codex', skills: [] }),
      },
      false,
    );

    const response = await surface.dispatch(request({ path: '/v1/projects', headers: human }));

    should(response.status).equal(200);
    should(ProjectInfoSchema.array().parse(jsonBody(response))).deepEqual([PROJECT]);
    should(reads).equal(1);
  });

  it('keeps catalog errors explicit, preserving API errors and translating ordinary failures', async () => {
    let failure: Error = new ApiError(409, 'the folder is already registered', 'project_exists');
    const surface = await dispatcher({
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
