import { describe, expect, test } from 'bun:test';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import manifest from '../../../manifest.ts';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { as, boot, makeCard } from '../../integration/daemon/harness.ts';

/** A machine with no gh on it: every spawn is a program that is not there. */
const noGh = async () => ({ exitCode: 127, signal: null, stdout: '', stderr: 'not found' });

describe('jobs parity', () => {
  test('J-0100 the sweep is a kernel job, not a timer, and one run of it ticks', async () => {
    const { host } = await boot();
    expect(host.jobIds()).toContain('board-sweep');
    await host.runJob('board-sweep');
    expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
  });

  test('J-0231 J-0080 the GitHub watch and the Unfiled refile are ONE kernel job; a host without gh is backed off, not an error', async () => {
    const { host } = await boot({ spawn: noGh });
    expect(host.jobIds()).toContain('board-github-watch');
    await makeCard(host);
    await host.runJob('board-github-watch');
    expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
  });

  test('J-0173 a gh call that runs past its time is reported failed, not hung', async () => {
    const { GhSpawnRunner } = await import('../../../daemon/adapters/github.ts');
    let asked: { timeout?: unknown } | undefined;
    const runner = new GhSpawnRunner(
      {
        run: async (_program: string, _args: readonly string[], options?: { timeout?: unknown }) => {
          asked = options;
          return { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' };
        },
      },
      5_000,
    );
    const outcome = await runner.run(['api', 'graphql']);
    expect(outcome.kind).toBe('failed');
    expect(asked?.timeout).toBeDefined();
  });

  test('J-0017 J-0018 the board import job and its route are gone', () => {
    expect(manifest.actions.routes.some(route => route.key.includes('/import'))).toBe(false);
  });

  test('J-0056 J-0061 the owner’s start on a card starts a ferret in the project’s folder with the card assigned to it', async () => {
    const folder = '/work/badge';
    const projects = fakeProjects({ folders: [folder] } as never);
    const { ferrets, host } = await boot({ uses: { projects } });
    const registered = await projects.register({ kind: 'existing-folder', path: folder });
    if (!registered.ok) throw new Error(registered.error.message);
    const project = registered.value;
    await host.request('PUT', `/v1/board/projects/${project.id}/switch`, { body: { on: true }, headers: as('owner') });
    await host.request('POST', `/v1/board/projects/${project.id}/lanes`, {
      body: { action: 'propose', template: 'pr', renames: {} },
      headers: as('owner'),
    });
    ferrets.add({ id: ferretId('g0') });
    ferrets.setState(ferretId('g0'), 'stopped');
    const card = await makeCard(host, { projectId: project.id, assignee: 'g0' });

    const started = await host.request('POST', `/v1/board/cards/${card.id}/start`, { headers: as('owner') });
    expect(started.status).toBe(200);
    const result = started.json<{ card: string; ferret: string; started: boolean }>();

    expect(result.started).toBe(true);
    expect((await ferrets.get(result.ferret as never))?.folder).toBe(folder);

    const read = await host.request('GET', `/v1/board/cards/${card.id}`, { headers: as('owner') });
    expect(read.json<{ card: { assignee: string | null } }>().card.assignee).toBe(result.ferret);
  });
});
