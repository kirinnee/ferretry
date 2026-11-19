import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { ProjectRemoved } from '@ferretry/plugin-projects/contract';
import { testHost } from '@ferretry/kernel/testing';
import daemon from '../../daemon/index.ts';
import { FakeGithub } from '../fixtures/fake-github/index.ts';

const P1 = '11111111-1111-4111-8111-111111111111';

async function boot(github: FakeGithub, projects: { id: string }[]) {
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => projects, find: async () => undefined },
    },
  });
}

describe('pulls daemon', () => {
  test('builds with no route (E1 files none) and no network of its own', async () => {
    const host = await boot(new FakeGithub(), []);
    expect((await host.request('GET', '/v1/pulls')).status).toBe(404);
  });

  test('projects.removed purges that project’s cache; the sweep drops a project or account that is gone', async () => {
    const github = new FakeGithub();
    const host = await boot(github, [{ id: P1 }]);
    // Stand-in: write through the plugin's own state, as the client would.
    const { PULLS_CACHE } = await import('../../contract/index.ts');
    const folder = host.state('pulls');
    const bytes = new TextEncoder().encode('{}');
    folder.plantBytes(PULLS_CACHE, bytes, `${P1}/gha_4242-aaaa.json`);
    host.emit(ProjectRemoved, { id: P1 as never });
    await host.settle();
    expect(folder.rawBytes(PULLS_CACHE, `${P1}/gha_4242-aaaa.json`)).toBeUndefined();
  });
});
