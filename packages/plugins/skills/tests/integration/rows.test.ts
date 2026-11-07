import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { testHost } from '@ferretry/kernel/testing';
import skills from '../../daemon/index.ts';
import { installRoutes } from '../../daemon/install-routes.ts';
import manifest from '../../manifest.ts';

const INSTALL_ROUTES = manifest.actions.routes.filter(route => route.key.includes('/v1/skills/installs/local'));
const demand = (key: string): string => {
  const route = manifest.actions.routes.find(candidate => candidate.key === key);
  return `${String(route?.capability?.capability)}.${route?.capability?.axis}`;
};
const PREVIEW_BODY = {
  source: { path: '/home/me/.claude/skills/demo/SKILL.md' },
  target: { scope: 'project', projectRoot: '/work/app', harness: 'claude-code' },
};
const RUNTIME_BODY = {
  source: { path: '/home/me/.claude/skills/demo/SKILL.md' },
  target: { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
};

async function host() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
  return await testHost({ plugins: [skills], fakes: { ferrets } });
}

describe('copying a skill from this machine', () => {
  test('G172 both previews are filesystem.use, so a device without it cannot read another account by naming a runtime', async () => {
    expect(demand('POST /v1/skills/installs/local/project/preview')).toBe('filesystem.use');
    expect(demand('POST /v1/skills/installs/local/runtime/preview')).toBe('filesystem.use');
    const h = await host();
    const caller = { kind: 'device', holder: 'dev_a', capabilities: ['fleet.use', 'fleet.configure'] } as const;
    for (const [path, body] of [
      ['project', PREVIEW_BODY],
      ['runtime', RUNTIME_BODY],
    ] as const)
      expect((await h.request('POST', `/v1/skills/installs/local/${path}/preview`, { body, as: caller })).status).toBe(
        403,
      );
    // With filesystem.use the request is admitted and reaches the inventory, which lists no such skill.
    const allowed = await h.request('POST', '/v1/skills/installs/local/runtime/preview', {
      body: RUNTIME_BODY,
      as: { kind: 'device', holder: 'dev_a', capabilities: ['filesystem.use'] },
    });
    expect(allowed.status).toBe(404);
    expect(allowed.json<{ code: string }>().code).toBe('local_skill_source_unknown');
  });

  test('G173 a project apply or remove is filesystem.configure; a runtime apply or remove is fleet.configure', async () => {
    expect(demand('POST /v1/skills/installs/local/project')).toBe('filesystem.configure');
    expect(demand('DELETE /v1/skills/installs/local/project/:installId')).toBe('filesystem.configure');
    expect(demand('POST /v1/skills/installs/local/runtime')).toBe('fleet.configure');
    expect(demand('DELETE /v1/skills/installs/local/runtime/:installId')).toBe('fleet.configure');
    const h = await host();
    const previewId = `lsp_${'a'.repeat(22)}`;
    const installId = `lsi_${'a'.repeat(22)}`;
    const fleetOnly = { kind: 'device', holder: 'dev_a', capabilities: ['fleet.configure'] } as const;
    const filesOnly = { kind: 'device', holder: 'dev_a', capabilities: ['filesystem.configure'] } as const;
    expect(
      (await h.request('POST', '/v1/skills/installs/local/project', { body: { previewId }, as: fleetOnly })).status,
    ).toBe(403);
    expect(
      (await h.request('DELETE', `/v1/skills/installs/local/project/${installId}`, { as: fleetOnly })).status,
    ).toBe(403);
    expect(
      (await h.request('POST', '/v1/skills/installs/local/runtime', { body: { previewId }, as: filesOnly })).status,
    ).toBe(403);
    expect(
      (await h.request('DELETE', `/v1/skills/installs/local/runtime/${installId}`, { as: filesOnly })).status,
    ).toBe(403);
    // The matching capability is admitted (and the unknown preview or copy is the answer).
    expect(
      (await h.request('POST', '/v1/skills/installs/local/project', { body: { previewId }, as: filesOnly })).status,
    ).toBe(404);
    expect(
      (await h.request('DELETE', `/v1/skills/installs/local/runtime/${installId}`, { as: fleetOnly })).status,
    ).toBe(404);
  });

  test('G174 every route is a person route, so a ferret is refused all of them; a governed apply needs a fresh catalog-install proof', async () => {
    expect(INSTALL_ROUTES.length).toBe(7);
    for (const route of INSTALL_ROUTES) expect(route.caller).toBe('person');
    const h = await host();
    for (const route of INSTALL_ROUTES) {
      const [method, path] = route.key.split(' ') as [string, string];
      const response = await h.request(method, path.replace(':installId', `lsi_${'a'.repeat(22)}`), {
        body: path.endsWith('/preview') ? PREVIEW_BODY : { previewId: `lsp_${'a'.repeat(22)}` },
        as: { kind: 'ferret', id: 'f1' },
      });
      expect(response.status).toBe(403);
    }
    // The handler also refuses a ferret before it reads a body (defence in depth behind admission).
    const handlers = installRoutes({
      list: async () => ({ installs: [] }),
      preview: async () => {
        throw new Error('must not be reached');
      },
      apply: async () => {
        throw new Error('must not be reached');
      },
      remove: async () => {
        throw new Error('must not be reached');
      },
    });
    const call = (extra: object) =>
      ({
        request: { text: async () => JSON.stringify({ previewId: `lsp_${'a'.repeat(22)}` }) },
        params: new Map(),
        ...extra,
      }) as never;
    await expect(
      handlers['POST /v1/skills/installs/local/project'](
        call({ credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'f1' } }),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'owner_only' });
    // A governed caller without a fresh proof gets the step-up body, not a copy.
    const governed = await handlers['POST /v1/skills/installs/local/runtime'](
      call({
        governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
        claimFreshStepUp: () => false,
      }),
    );
    expect(governed.status).toBe(403);
    const body = JSON.parse(governed.body) as {
      code: string;
      demand: { act: string; capability: string; axis: string };
    };
    expect(body.code).toBe(STEP_UP_REQUIRED_CODE);
    expect(body.demand).toEqual({ capability: 'fleet', axis: 'configure', act: 'catalog-install' });
  });

  test('G175 the copy source is never taken from the request: it must be an inventory skill found again by its SKILL.md path', async () => {
    const h = await host();
    for (const path of [
      '/etc/passwd',
      '/home/me/.claude/skills/demo/other.md',
      '/home/me/.claude/skills/demo/SKILL.md',
    ]) {
      const response = await h.request('POST', '/v1/skills/installs/local/project/preview', {
        body: { source: { path }, target: PREVIEW_BODY.target },
      });
      expect(response.status).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('local_skill_source_unknown');
    }
  });
});

describe('the skills half as the host runs it', () => {
  test('a ferret that does not exist is 404 on its skills, and the machine inventory answers', async () => {
    const h = await host();
    expect((await h.request('GET', '/v1/ferrets/nobody/skills')).status).toBe(404);
    expect((await h.request('GET', '/v1/ferrets/nobody/skills/inventory')).status).toBe(404);
    expect((await h.request('GET', '/v1/skills')).status).toBe(200);
  });

  test('the file route needs a path and serves only a listed one', async () => {
    const h = await host();
    expect((await h.request('GET', '/v1/skills/file')).status).toBe(400);
    expect((await h.request('GET', '/v1/skills/file', { query: { path: '/etc/passwd' } })).status).toBe(404);
  });
});
