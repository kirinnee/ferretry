import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { TerminalRoots, type TerminalRootsSource, WorktreesFile } from '../../../../contract/index.ts';
import { host } from '../ferrets/route-fixture.ts';

/** G3 U1: the daemon's own worktrees feature reads `terminal.roots` (the real host, a stand-in for Terminals). */

const PATH = '/worktrees/repo/feat-one';
const registry = JSON.stringify({
  format: 1,
  intents: [],
  worktrees: [
    {
      version: 1,
      path: PATH,
      branch: 'feat/one',
      repositoryRoot: '/work/ferretry',
      commonDir: '/work/ferretry/.git',
      gitDir: '/work/ferretry/.git/worktrees/one',
      ownershipToken: 'token-one',
      createdAt: '2026-08-04T00:00:00.000Z',
      initialHead: 'a'.repeat(40),
      branchPreexisted: false,
      sourceCwd: '/work/ferretry',
      relativeCwd: '',
    },
  ],
});

const fakeTerminals = (source: TerminalRootsSource) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: TerminalRoots }] },
    }),
    { build: () => ({ hooks: { 'terminal.roots': () => [{ id: 'terminals', item: source }] } }) },
  );

const blockerCodes = async (plugins: Parameters<typeof host>[1]) => {
  const h = await host([], plugins);
  h.state('ferrets').plant(WorktreesFile, registry);
  const answer = await h.request('GET', '/v1/worktrees/removal', { query: { path: PATH } });
  await h.stop();
  expect(answer.status).toBe(200);
  return answer.json<{ blockers: { code: string }[] }>().blockers.map(blocker => blocker.code);
};

describe('the worktrees feature reads the contributed terminal roots', () => {
  test('G3-U1 with no Terminals, no shell is unknown: the removal check carries no undetermined blocker', async () => {
    expect(await blockerCodes({})).not.toContain('undetermined_evidence');
  });

  test('G3-U1 a Terminals that lists its shells adds no undetermined blocker', async () => {
    expect(
      await blockerCodes({
        plugins: [
          fakeTerminals({ roots: async () => ['/elsewhere'], withRemoval: async (_path, remove) => await remove() }),
        ],
      }),
    ).not.toContain('undetermined_evidence');
  });

  test('G3-U1 a Terminals that cannot list its shells is unknown, and says so', async () => {
    const broken = fakeTerminals({
      withRemoval: async (_path, remove) => await remove(),
      roots: async () => {
        throw new Error('tmux would not answer');
      },
    });
    expect(await blockerCodes({ plugins: [broken] })).toContain('undetermined_evidence');
  });
});
