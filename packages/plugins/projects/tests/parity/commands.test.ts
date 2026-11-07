import { describe, expect, test } from 'bun:test';
import cli from '../../cli/index.ts';
import manifest from '../../manifest.ts';

const declared = new Set<string>(manifest.actions?.cli?.map(entry => entry.verb) ?? []);

const PROJECT = {
  id: '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-10-30T10:00:00.000Z',
};

function run(verb: string, args: string[] = [], registry: unknown[] = [PROJECT]) {
  const calls: { route: string; init?: unknown }[] = [];
  let out = '';
  let err = '';
  const half = cli.build?.({
    manifest,
    client: {
      call: async (route: string, init?: unknown) => {
        calls.push({ route, init });
        return route === 'GET /v1/projects' ? registry : PROJECT;
      },
      subscribe: () => () => {},
    },
    io: { out: (text: string) => (out += text), err: (text: string) => (err += text), isTty: false },
  } as never);
  const verbs = (half?.verbs ?? {}) as Record<string, (invocation: unknown) => Promise<number>>;
  const handler = verbs[verb];
  if (handler === undefined) return Promise.reject(new Error(`the half does not implement "${verb}"`));
  return handler({ args, options: {} }).then(code => ({ code, out, err, calls }));
}

describe('project command parity', () => {
  test('V-0361 fy project is the group of add, list and remove', () => {
    for (const verb of ['project add', 'project list', 'project remove']) expect(declared.has(verb)).toBe(true);
  });

  test('V-0362 fy project add <path> registers the folder and prints the record', async () => {
    const result = await run('project add', ['/work/new'], []);
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.route)).toEqual(['GET /v1/projects', 'POST /v1/projects']);
    expect(result.out).toContain('registered:');
  });

  test('V-0364 fy project ls is now fy project list: every registered project, name, id and folder', async () => {
    expect(declared.has('project list')).toBe(true);
    const result = await run('project list');
    expect(result.code).toBe(0);
    expect(result.out).toContain(`ferretry  ${PROJECT.id}  /work/ferretry`);
  });

  test('V-0363 fy project list as an alias of ls is removed by design (§1.4: no aliases); list is the one name', () => {
    expect(declared.has('project ls')).toBe(false);
    return expect(run('project ls')).rejects.toThrow(/does not implement/u);
  });

  test('V-0365 fy projects is removed by design (§1.4: no aliases)', () => {
    expect([...declared].filter(verb => verb.startsWith('projects'))).toEqual([]);
    return expect(run('projects list')).rejects.toThrow(/does not implement/u);
  });

  test('V-0361 fy project remove is new: it deletes the registered project and leaves the folder', async () => {
    const result = await run('project remove', ['ferretry']);
    expect(result.code).toBe(0);
    expect(result.calls.at(-1)).toEqual({ route: 'DELETE /v1/projects/:id', init: { params: { id: PROJECT.id } } });
  });
});
