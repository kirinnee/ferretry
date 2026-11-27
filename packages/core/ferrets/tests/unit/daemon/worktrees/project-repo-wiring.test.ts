import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { LAUNCH_ROOTS_KEY, LaunchRoots, type LaunchRootsSource } from '../../../../contract/index.ts';
import { host } from '../ferrets/route-fixture.ts';

/** R2-1: the repository list for a project asks Projects (through `launch.roots`) by id, and takes no directory from the caller. */

const fakeProjects = (source: LaunchRootsSource) =>
  implementDaemon(
    definePlugin({
      id: 'projects',
      title: 'Projects (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: LaunchRoots, key: LAUNCH_ROOTS_KEY }] },
    }),
    { build: () => ({ hooks: { [`launch.roots:${LAUNCH_ROOTS_KEY}`]: source } }) },
  );

const ask = async (plugins: Parameters<typeof host>[1], query: Record<string, string>) => {
  const h = await host([], plugins);
  const answer = await h.request('GET', '/v1/worktrees/repo', { query });
  await h.stop();
  return answer;
};

describe('the repository list names a project by id', () => {
  test('an id Projects does not know is 422, and a path beside it is 400', async () => {
    const asked: string[] = [];
    const plugins = {
      plugins: [
        fakeProjects({
          roots: async () => [],
          repository: async project => {
            asked.push(project);
            return undefined;
          },
        }),
      ],
    };
    expect((await ask(plugins, { project: 'nobody' })).status).toBe(422);
    expect(asked).toEqual(['nobody']);
    expect((await ask(plugins, { project: 'nobody', commonDir: '/somewhere/.git' })).status).toBe(400);
    expect(asked).toEqual(['nobody']);
  });

  test('with no Projects running, a project id is 422 (it opens nothing)', async () => {
    expect((await ask({}, { project: 'any' })).status).toBe(422);
  });
});
