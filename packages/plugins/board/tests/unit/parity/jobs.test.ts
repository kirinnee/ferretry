import { describe, expect, test } from 'bun:test';
import type { SpawnOptions, SpawnResult } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import type { WorkSource } from '@ferretry/plugin-conversation/contract';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import manifest from '../../../manifest.ts';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { as, boot, makeCard } from '../../integration/daemon/harness.ts';

/**
 * A machine with nothing installed, as the kernel's spawn surfaces it: Bun refuses to start a program it cannot find,
 * so `spawn.run` REJECTS (ENOENT), it does not resolve with an exit code.
 */
const nothingInstalled =
  (asked: string[]) =>
  async (program: string): Promise<SpawnResult> => {
    asked.push(program);
    throw Object.assign(new Error(`Executable not found in $PATH: "${program}"`), { code: 'ENOENT' });
  };

/** Lets every pending promise chain run. */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('jobs parity', () => {
  test('J-0100 the sweep is a kernel job, not a timer, and one run of it ticks', async () => {
    const { host } = await boot();
    expect(host.jobIds()).toContain('board-sweep');
    await host.runJob('board-sweep');
    expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
  });

  test('J-0231 the GitHub watch first looks about 20 s after start, and a host without gh is backed off, not an error', async () => {
    const asked: string[] = [];
    const { host } = await boot({ spawn: nothingInstalled(asked) });
    expect(host.jobIds()).toContain('board-github-watch');
    const card = await makeCard(host);
    const linked = await host.request('POST', `/v1/board/cards/${card.id}`, {
      body: { action: 'link', pr: 'https://github.com/kirinnee/ferretry/pull/940' },
      headers: as('owner'),
    });
    expect(linked.status).toBe(200);

    const running = host.runJob('board-github-watch');
    await flush();
    await host.clock.advance(17_999);
    await flush();
    expect(asked.filter(program => program === 'gh')).toEqual([]);
    await host.clock.advance(4_001);
    await flush();
    expect(asked.filter(program => program === 'gh').length).toBeGreaterThan(0);
    expect(host.logs.some(entry => entry.level === 'warn' && entry.message.includes('`gh` is not installed'))).toBe(
      true,
    );

    await host.stop();
    await running;
    expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
  });

  test('J-0231 the gh runner reports a gh that is not installed as missing', async () => {
    const { GhSpawnRunner } = await import('../../../daemon/adapters/github.ts');
    const runner = new GhSpawnRunner({ run: nothingInstalled([]) }, fixedClock());
    expect(await runner.run(['api', 'graphql'])).toEqual({ kind: 'missing' });
  });

  test('J-0080 the Unfiled refile is its own job beside the GitHub watch, run once at start', async () => {
    const { host } = await boot({ spawn: nothingInstalled([]) });
    expect(host.jobIds()).toEqual(expect.arrayContaining(['board-github-watch', 'board-unfiled-refile']));
    await makeCard(host);
    await host.runJob('board-unfiled-refile');
    expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
  });

  test('J-0173 a gh call that runs past its time is killed and reported failed, passing none of its output on', async () => {
    const { GhSpawnRunner } = await import('../../../daemon/adapters/github.ts');
    const clock = fixedClock();
    let asked: SpawnOptions | undefined;
    // What the kernel's spawn really returns for a child killed by its signal: an ordinary exit, 143 (SIGTERM), with
    // `signal: null` and whatever the child had printed so far.
    const runner = new GhSpawnRunner(
      {
        run: async (_program: string, _args: readonly string[], options?: SpawnOptions) => {
          asked = options;
          return await new Promise<SpawnResult>(resolve => {
            options?.signal?.addEventListener('abort', () => {
              resolve({ exitCode: 143, signal: null, stdout: '{"data":{"repository":', stderr: '' });
            });
          });
        },
      },
      clock,
      5_000,
    );
    const outcome = runner.run(['api', 'graphql']);
    await clock.advance(4_999);
    expect(asked?.signal?.aborted).toBe(false);
    await clock.advance(1);
    expect(await outcome).toEqual({ kind: 'failed', detail: 'gh took longer than 5000 ms', stdout: '' });
    expect(asked?.signal?.aborted).toBe(true);
  });

  test('J-0173 a gh that exits 143 by itself, before its time, is reported as that exit with what it printed', async () => {
    const { GhSpawnRunner } = await import('../../../daemon/adapters/github.ts');
    const clock = fixedClock();
    const runner = new GhSpawnRunner(
      { run: async () => ({ exitCode: 143, signal: null, stdout: 'partial', stderr: '' }) },
      clock,
      5_000,
    );
    expect(await runner.run(['api', 'graphql'])).toEqual({
      kind: 'failed',
      detail: 'gh exited 143',
      stdout: 'partial',
    });
    expect(clock.pending()).toBe(0);
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

  test('J-0091 the work search no longer watches the board’s directory: Board hands Conversation its cards through search.sources, which re-indexes by identity', async () => {
    const world = await boot({ uses: { conversation: fakeConversation() } });
    const made = await makeCard(world.host);
    const [contribution] = world.contribution('search.sources') as { id: string; item: WorkSource }[];
    expect(contribution?.id).toBe('board');
    const before = (await contribution?.item.list()) ?? [];
    expect(before.map(work => work.key)).toEqual([`card:${made.id}`]);
    expect((await contribution?.item.list())?.[0]).toBe(before[0]);
    await world.host.request('POST', `/v1/board/cards/${made.id}`, {
      body: { action: 'note', text: 'a change the search must see' },
      headers: as('owner'),
    });
    expect((await contribution?.item.list())?.[0]).not.toBe(before[0]);
  });
});
