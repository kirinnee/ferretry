import { describe, expect, test } from 'bun:test';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import manifest from '../../../manifest.ts';
import { ConversationOwnerWords } from '../../../daemon/adapters/owner-words.ts';
import { as, boot, makeCard } from '../../integration/daemon/harness.ts';

const stateFile = (host: Awaited<ReturnType<typeof boot>>['host'], path: string): Record<string, unknown> => {
  const text = host.state('board').files.get(path);
  if (text === undefined) throw new Error(`no state/board/${path}`);
  return JSON.parse(text) as Record<string, unknown>;
};

describe('storage parity', () => {
  test('F-0225 F-0228 F-0229 the cards are state/board/cards/<id>.json, one file per card, format 1 first', async () => {
    const { host } = await boot();
    const card = await makeCard(host);
    const stored = stateFile(host, `cards/${card.id}.json`);
    expect(stored.format).toBe(1);
    expect(stored.id).toBe(card.id);
    expect(manifest.data.state.map(file => file.path)).toContain('cards/*.json');
  });

  test('F-0090 F-0226 the id counter is state/board/counters.json and is never reused', async () => {
    const { host } = await boot();
    const first = await makeCard(host);
    const second = await makeCard(host);
    expect(Number(second.id.slice(1))).toBeGreaterThan(Number(first.id.slice(1)));
    const counters = stateFile(host, 'counters.json') as { format: number; next: Record<string, number> };
    expect(counters.format).toBe(1);
    expect(counters.next.feature).toBeGreaterThan(Number(second.id.slice(1)));
  });

  test('F-0227 F-0414 the sweep remembers what it saw in state/board/sweep.json', async () => {
    const { host } = await boot();
    await makeCard(host);
    await host.runJob('board-sweep');
    const sweep = stateFile(host, 'sweep.json');
    expect(sweep.format).toBe(1);
    expect(sweep.sweptAt).not.toBeNull();
  });

  test('F-0112 F-0113 F-0114 a board’s lane set and its switch are ONE file per project, boards/<project>.json', async () => {
    const { host } = await boot();
    await host.request('PUT', '/v1/board/projects/unfiled/switch', { body: { on: true }, headers: as('owner') });
    const board = stateFile(host, 'boards/unfiled.json') as {
      format: number;
      project: string;
      switch: { on: boolean };
    };
    expect(board.format).toBe(1);
    expect(board.project).toBe('unfiled');
    expect(board.switch.on).toBe(true);
    expect(manifest.data.state.map(file => file.path)).toContain('boards/*.json');
  });

  test('F-0110 F-0111 F-0337 the board import record and the per-ferret tasks.json are gone: no state file, no route, no verb', () => {
    const paths = manifest.data.state.map(file => file.path);
    expect(paths.some(path => /import|tasks/.test(path))).toBe(false);
    expect(manifest.actions.routes.some(route => /import|\/tasks/.test(route.key))).toBe(false);
    expect(manifest.actions.cli.some(verb => verb.verb.includes('import'))).toBe(false);
  });

  test('F-0007 a working copy’s remote and branch are asked of git, not read from its config files', async () => {
    const { GitSpawnCopies } = await import('../../../daemon/adapters/github.ts');
    const asked: string[][] = [];
    const copies = new GitSpawnCopies(
      {
        run: async (program: string, args: readonly string[]) => {
          asked.push([program, ...args]);
          return {
            exitCode: 0,
            signal: null,
            stderr: '',
            stdout: args.includes('get-url') ? 'git@github.com:kirinnee/ferretry.git\n' : 'refs/heads/main\n',
          };
        },
      },
      { nowMs: () => 0 },
    );
    expect(await copies.repositoryOf('/work/ferretry')).toBe('kirinnee/ferretry');
    expect(await copies.branchOf('/work/ferretry')).toBe('main');
    expect(asked.every(call => call[0] === 'git')).toBe(true);
  });

  test('F-0001 who wrote each turn (today’s .by.json) is read through Conversation: the owner’s words come from ownerWords, strictly for a private choice', async () => {
    // Today Board read turn-NNN.by.json itself; the author of each turn is Conversation's, and Board asks for the words.
    const conversation = fakeConversation();
    await conversation.send(ferretId('f1'), { kind: 'owner' }, { message: 'build the board' });
    await conversation.send(ferretId('f1'), { kind: 'ferret', ferret: ferretId('f2') }, { message: 'from a peer' });
    const words = new ConversationOwnerWords(() => conversation);

    expect(await words.said('f1', { strict: true })).toEqual(['build the board']);
    await expect(new ConversationOwnerWords(() => undefined).said('f1', { strict: true })).rejects.toThrow();
    expect(manifest.data.state.map(file => file.path).some(path => path.includes('.by.json'))).toBe(false);
  });
});
