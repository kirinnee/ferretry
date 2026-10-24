import { describe, it } from 'bun:test';
import { ProjectInfoSchema, type RegisterProjectRequest } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiError, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type CatalogSubsystem, catalogRoutes } from '../../../../src/lib/runtime/mounts/catalogs.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, grantSubsystem, human, sessionDirectory, sessionView } from './support.ts';

const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ferretry',
  path: '/work/ferretry',
  source: 'existing-folder' as const,
  createdAt: '2026-08-04T00:00:00.000Z',
};

/** The inventory members a case about something else does not exercise. */
const NO_INVENTORY = {
  skillsInventory: async () => ({ homes: [], projects: [], truncated: false }),
  sessionSkillsInventory: async () => ({ sessionId: 's1', harness: 'codex' as const, skills: [], truncated: false }),
  skillFile: async () => undefined,
};

interface FilesystemGrant {
  readonly use: boolean;
  readonly configure: boolean;
}

/** The PRODUCT's own permissive answer, not a copy of it: a case named after the default must move
 *  with the default, or it keeps passing under a name that has stopped being true. */
const FILESYSTEM_GRANTED: FilesystemGrant = DEFAULT_CAPABILITY_GRANTS.filesystem;
const FILESYSTEM_DISABLED: FilesystemGrant = { use: false, configure: false };

/**
 * A remote paired browser that has confirmed with its passkey. Registering a project is
 * `filesystem.configure`, which a remote caller reaches only with a live step-up — so a case about what
 * the route does once past the gate is told from this device rather than from a bearer with none.
 */
const phone = { deviceId: 'fy_device_id_phone', appSession: 'app-one' } as const;

async function dispatcher(
  catalogs: CatalogSubsystem,
  filesystem: FilesystemGrant = FILESYSTEM_GRANTED,
): Promise<ApiDispatcher> {
  const grants = grantSubsystem({
    grants: {
      ...DEFAULT_CAPABILITY_GRANTS,
      filesystem,
    },
  });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(catalogRoutes(catalogs, sessionDirectory())), CREDENTIALS, grants, undefined, {
    held: device => device.deviceId === phone.deviceId,
  });
}

describe('the project catalog mount', () => {
  it('lets a remote caller register while the permissive filesystem default is enabled', async () => {
    const registered: RegisterProjectRequest[] = [];
    const response = await (
      await dispatcher({
        projects: async () => [],
        registerProject: async entry => {
          registered.push(entry);
          return PROJECT;
        },
        skills: async () => ({ harness: 'codex', skills: [] }),
        ...NO_INVENTORY,
      })
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/projects',
        device: phone,
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
        ...NO_INVENTORY,
      },
      FILESYSTEM_DISABLED,
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
        ...NO_INVENTORY,
      },
      FILESYSTEM_DISABLED,
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
        'the operator of this machine has not granted the UI permission to change the settings for the project filesystem. Grant it on the host with `fy daemon config set filesystem --configure`.',
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
        ...NO_INVENTORY,
      },
      FILESYSTEM_DISABLED,
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
      ...NO_INVENTORY,
    });
    const requestProject = () =>
      surface.dispatch(
        request({
          method: 'POST',
          path: '/v1/projects',
          device: phone,
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

  it('answers 422 and mutates nothing when a relative project path arrives', async () => {
    const registered: RegisterProjectRequest[] = [];
    const response = await (
      await dispatcher({
        projects: async () => [],
        registerProject: async entry => {
          registered.push(entry);
          return PROJECT;
        },
        skills: async () => ({ harness: 'codex', skills: [] }),
        ...NO_INVENTORY,
      })
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/projects',
        device: phone,
        body: JSON.stringify({ kind: 'existing-folder', path: 'relative/path' }),
      }),
    );

    // A relative path is parseable but refused on policy, so it is a 422, not a 400 — and the
    // catalog subsystem is never reached, so nothing is mutated.
    const body = jsonBody(response);
    should(response.status).equal(422);
    should(body.code).equal('project_registration_failed');
    should(String(body.error).includes('absolute')).be.true();
    should(registered).be.empty();
  });

  it('answers 400 for a genuinely malformed registration body', async () => {
    const registered: RegisterProjectRequest[] = [];
    const response = await (
      await dispatcher({
        projects: async () => [],
        registerProject: async entry => {
          registered.push(entry);
          return PROJECT;
        },
        skills: async () => ({ harness: 'codex', skills: [] }),
        ...NO_INVENTORY,
      })
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/projects',
        device: phone,
        body: '{not json',
      }),
    );

    // A body that cannot be read as JSON stays 400.
    should(response.status).equal(400);
    should(jsonBody(response)).match({ code: 'invalid_json' });
    should(registered).be.empty();
  });

  it('keeps a parseable but non-policy-invalid registration body at 400', async () => {
    const registered: RegisterProjectRequest[] = [];
    const response = await (
      await dispatcher({
        projects: async () => [],
        registerProject: async entry => {
          registered.push(entry);
          return PROJECT;
        },
        skills: async () => ({ harness: 'codex', skills: [] }),
        ...NO_INVENTORY,
      })
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/projects',
        device: phone,
        body: JSON.stringify({ kind: 'existing-folder' }),
      }),
    );

    should(response.status).equal(400);
    should(jsonBody(response)).match({ code: 'invalid_request' });
    should(registered).be.empty();
  });
});

describe('the skills inventory mounts', () => {
  const view = sessionView('s1', { harness: 'codex', agent: 'codex-main' });
  const inventory = {
    ...NO_INVENTORY,
    skillsInventory: async () => ({ homes: [], projects: [], truncated: false }),
    sessionSkillsInventory: async () => ({
      sessionId: 's1',
      harness: 'codex' as const,
      runtime: 'codex-main',
      skills: [],
      truncated: false,
    }),
    skillFile: async (path: string) => (path === '/home/skills/a/SKILL.md' ? '# a' : undefined),
  };
  const catalogs: CatalogSubsystem = {
    projects: async () => [],
    registerProject: async () => PROJECT,
    skills: async () => ({ harness: 'codex', skills: [] }),
    ...inventory,
  };

  async function ask(
    path: string,
    query: readonly (readonly [string, string])[] = [],
    filesystem: FilesystemGrant = FILESYSTEM_GRANTED,
    fleetUse = true,
  ) {
    const grants = grantSubsystem({
      grants: {
        ...DEFAULT_CAPABILITY_GRANTS,
        filesystem,
        fleet: { ...DEFAULT_CAPABILITY_GRANTS.fleet, use: fleetUse },
      },
    });
    await grants.refresh();
    const surface = new ApiDispatcher(
      new ApiRouter(catalogRoutes(catalogs, sessionDirectory([view]))),
      CREDENTIALS,
      grants,
    );
    return await surface.dispatch(request({ path, query, headers: human }));
  }

  it('answers the machine inventory with no-store', async () => {
    const response = await ask('/v1/skills');
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual({ homes: [], projects: [], truncated: false });
  });

  it('answers one session its own inventory and 404s an unknown session', async () => {
    should((await ask('/v1/sessions/s1/skills/inventory')).status).equal(200);
    should((await ask('/v1/sessions/nope/skills/inventory')).status).equal(404);
  });

  it('serves a listed SKILL.md and refuses an unlisted path', async () => {
    const listed = await ask('/v1/skills/file', [['path', '/home/skills/a/SKILL.md']]);
    should(listed.status).equal(200);
    should(jsonBody(listed)).deepEqual({ path: '/home/skills/a/SKILL.md', content: '# a' });
    should((await ask('/v1/skills/file', [['path', '/etc/passwd']])).status).equal(404);
    should((await ask('/v1/skills/file')).status).equal(400);
  });
});
