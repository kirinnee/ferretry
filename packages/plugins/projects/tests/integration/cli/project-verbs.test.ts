import { describe, it } from 'bun:test';
import should from 'should';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

const PROJECT = {
  id: '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-10-30T10:00:00.000Z',
};

interface Call {
  route: string;
  init?: unknown;
}

/** The half built the way the shell builds it, over a recording client and terminal. */
const harness = (registry: unknown[] = []) => {
  const calls: Call[] = [];
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
  const run = async (verb: string, args: string[] = [], options: Record<string, string | boolean> = {}) => {
    const handler = verbs[verb];
    if (handler === undefined) throw new Error(`the half does not implement "${verb}"`);
    return await handler({ args, options });
  };
  return { calls, run, text: () => ({ out, err }) };
};

describe('the project verbs', () => {
  it('should post `project add` as an absolute folder to the registry, after reading it to tell new from old', async () => {
    const { calls, run, text } = harness();
    const code = await run('project add', ['/work/ferretry'], { name: 'ferretry' });
    should(code).equal(0);
    should(calls).eql([
      { route: 'GET /v1/projects', init: undefined },
      {
        route: 'POST /v1/projects',
        init: { body: { kind: 'existing-folder', path: '/work/ferretry', name: 'ferretry' } },
      },
    ]);
    should(text().out).startWith('registered: ferretry');
  });

  it('should say a folder is already registered when the registry held it before', async () => {
    const { run, text } = harness([PROJECT]);
    await run('project add', ['/work/ferretry']);
    should(text().out).startWith('already registered: ferretry');
  });

  it('should list the registry, also as JSON', async () => {
    const { run, text } = harness([PROJECT]);
    await run('project list');
    await run('project list', [], { json: true });
    const lines = text().out.trim().split('\n');
    should(lines[0]).equal(`ferretry  ${PROJECT.id}  /work/ferretry`);
    should(JSON.parse(lines.slice(1).join('\n'))).eql([PROJECT]);
  });

  it('should delete a project by id with `project remove`, finding it by its name first', async () => {
    const { calls, run, text } = harness([PROJECT]);
    const code = await run('project remove', ['ferretry']);
    should(code).equal(0);
    should(calls.at(-1)).eql({ route: 'DELETE /v1/projects/:id', init: { params: { id: PROJECT.id } } });
    should(text().out).startWith('removed: ferretry');
  });

  it('should exit 1 with the refusal on stderr for a blank folder or an unknown project', async () => {
    const blank = harness();
    should(await blank.run('project add', ['  '])).equal(1);
    should(blank.text().err).match(/say which folder/u);
    const unknown = harness([PROJECT]);
    should(await unknown.run('project remove', ['ghost'])).equal(1);
    should(unknown.text().err).match(/no project "ghost"/u);
    should(unknown.calls.map(call => call.route)).eql(['GET /v1/projects']);
  });

  it('should answer no alias: `projects` and `project ls` are gone', async () => {
    const { run } = harness();
    await should(run('project ls')).be.rejectedWith(/does not implement/u);
    await should(run('projects list')).be.rejectedWith(/does not implement/u);
  });
});
