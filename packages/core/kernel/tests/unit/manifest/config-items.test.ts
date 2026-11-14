/**
 * The item verbs of a configuration collection (`fy mcp add|show|edit|rm|ls`, `fy harness … settings|hooks …`; triage B06,
 * parity rows V-0183 … V-0188), against a fake kernel that keeps the files in memory and answers the four config routes the
 * way the real ones do: an etag per read, a write refused when it carries a stale etag, a `422 config_invalid` carrying
 * located issues, and a removal that needs the etag it was read at.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { configItemVerbs, MCP_ITEM_KEYS } from '../../../manifest/config-items.ts';
import type { VerbInvocation } from '../../../manifest/implement.ts';

class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

const STARTER = '# yaml-language-server: $schema=../.schema/mcp--item.json\n';

class FakeKernel {
  readonly calls: { readonly route: string; readonly init: unknown }[] = [];
  readonly files = new Map<string, string>();
  held = false;
  private version = 0;
  private etagOf(path: string): string {
    return `etag-${path}-${String(this.version)}`;
  }

  async call<T>(route: string, init?: { query?: Record<string, string>; body?: Record<string, string> }): Promise<T> {
    this.calls.push({ route, init });
    switch (route) {
      case 'GET /v1/config/status':
        return {
          directory: '/home/.fy/config',
          files: [...this.files.keys()].map(path => ({ path, kind: 'mcp', state: 'ok' })),
          issues: [],
          pending: [],
        } as T;
      case 'GET /v1/config/file': {
        const path = init?.query?.path as string;
        const text = this.files.get(path);
        return { path, exists: text !== undefined, text: text ?? STARTER, etag: this.etagOf(path), state: 'ok' } as T;
      }
      case 'PUT /v1/config/file': {
        const { path, text, etag } = (init?.body ?? {}) as { path: string; text: string; etag: string };
        if (etag !== this.etagOf(path)) throw new Refusal('changed since it was read', 409, { error: 'changed' });
        if (text.includes('BAD'))
          throw new Refusal('the file does not check (1 problem); nothing was written', 422, {
            error: 'the file does not check (1 problem); nothing was written',
            code: 'config_invalid',
            issues: [{ path, line: 2, column: 3, severity: 'error', message: 'unknown key', fix: 'remove it' }],
          });
        this.version += 1;
        if (!this.held) this.files.set(path, text);
        return (
          this.held
            ? {
                path,
                etag: this.etagOf(path),
                outcome: 'pending',
                pending: { path, etag: 'e', changes: ['it loosens'] },
              }
            : { path, etag: this.etagOf(path), outcome: 'applied' }
        ) as T;
      }
      case 'DELETE /v1/config/file': {
        const { path, etag } = (init?.query ?? {}) as { path: string; etag: string };
        if (etag !== this.etagOf(path)) throw new Refusal('changed since it was read', 409, { error: 'changed' });
        this.files.delete(path);
        return { path, etag, outcome: 'removed' } as T;
      }
      default:
        throw new Error(`unexpected ${route}`);
    }
  }
}

const harness = (
  over: { readText?: (path: string) => Promise<string>; confirm?: (q: string) => Promise<boolean> } = {},
) => {
  const kernel = new FakeKernel();
  const out: string[] = [];
  const err: string[] = [];
  const verbs = configItemVerbs({
    collection: 'mcp',
    noun: 'MCP server',
    verbPrefix: 'mcp',
    client: kernel as never,
    io: { out: t => out.push(t), err: t => err.push(t), isTty: false },
    readText: over.readText ?? (async () => 'command: docs-server\n'),
    confirm: over.confirm ?? (async () => false),
    keys: MCP_ITEM_KEYS,
  });
  const run = async (verb: keyof typeof verbs, args: string[], options: VerbInvocation['options'] = {}) =>
    await verbs[verb]({ args, options });
  return { kernel, run, out: () => out.join(''), err: () => err.join('') };
};

const writes = (kernel: FakeKernel) =>
  kernel.calls.filter(call => call.route.startsWith('PUT') || call.route.startsWith('DELETE'));

describe('ls', () => {
  it('should list the items of the collection by name, and ignore other folders', async () => {
    const { kernel, run, out } = harness();
    kernel.files.set('mcp/b.yaml', 'command: b\n');
    kernel.files.set('mcp/a.yaml', 'command: a\n');
    kernel.files.set('skills/x.yaml', 'x: 1\n');
    should(await run('ls', [])).equal(0);
    should(out()).equal('a\nb\n');
  });

  it('should say how to add one when there are none', async () => {
    const { run, out } = harness();
    should(await run('ls', [])).equal(0);
    should(out()).containEql('No MCP server items yet. Add one with `fy mcp add <name>`.');
  });

  it('should print JSON on --json', async () => {
    const { kernel, run, out } = harness();
    kernel.files.set('mcp/a.yaml', 'command: a\n');
    await run('ls', [], { json: true });
    should(JSON.parse(out())).eql({ items: [{ name: 'a', path: 'mcp/a.yaml', state: 'ok' }] });
  });
});

describe('show', () => {
  it('should print the item with its etag, and refuse a name that does not exist', async () => {
    const { kernel, run, out, err } = harness();
    kernel.files.set('mcp/a.yaml', 'command: a\n');
    should(await run('show', ['a'])).equal(0);
    should(out()).containEql('mcp/a.yaml (ok)').and.containEql('etag: etag-mcp/a.yaml-0').and.containEql('command: a');
    should(await run('show', ['nope'])).equal(1);
    should(err()).containEql('There is no MCP server nope. See them all with `fy mcp ls`.');
  });

  it('should refuse a name that is a path, before any call', async () => {
    const { kernel, run, err } = harness();
    should(await run('show', ['../machine'])).equal(2);
    should(err()).containEql('is not a name');
    should(kernel.calls).eql([]);
  });
});

describe('add', () => {
  it('should write the --file text against the etag it read, and say so', async () => {
    const { kernel, run, out } = harness();
    should(await run('add', ['docs'], { file: 'docs.yaml' })).equal(0);
    should(out()).equal('Added MCP server docs.\n');
    should(kernel.files.get('mcp/docs.yaml')).equal('command: docs-server\n');
    should(writes(kernel)[0]?.init).eql({
      body: { path: 'mcp/docs.yaml', text: 'command: docs-server\n', etag: 'etag-mcp/docs.yaml-0' },
    });
  });

  it('should build the item from flags, keeping the schema modeline of the starter', async () => {
    const { kernel, run } = harness();
    should(
      await run('add', ['docs'], {
        command: 'docs-server',
        arg: ['--stdio', '--quiet'],
        env: ['REGION=eu', 'TOKEN=' + '$' + '{secret:DOCS}'],
      }),
    ).equal(0);
    const text = kernel.files.get('mcp/docs.yaml') as string;
    should(text).startWith('# yaml-language-server: $schema=../.schema/mcp--item.json');
    should(text).containEql('command: docs-server').and.containEql('--stdio').and.containEql('REGION: eu');
  });

  it('should refuse an item that already exists, naming edit, and write nothing', async () => {
    const { kernel, run, err } = harness();
    kernel.files.set('mcp/docs.yaml', 'command: a\n');
    should(await run('add', ['docs'], { file: 'x' })).equal(1);
    should(err()).containEql('There is already a MCP server docs. Change it with `fy mcp edit docs`.');
    should(writes(kernel)).eql([]);
  });

  it('should ask what the item is when no file or flag was given', async () => {
    const { kernel, run, err } = harness();
    should(await run('add', ['docs'])).equal(2);
    should(err()).containEql('Say what the MCP server is: --file <path>, --command, --arg, --url, --env.');
    should(writes(kernel)).eql([]);
  });

  it('should refuse a file and flags together, and a command and a url together', async () => {
    const { run, err } = harness();
    should(await run('add', ['docs'], { file: 'x', command: 'c' })).equal(2);
    should(err()).containEql('not both');
    should(await run('add', ['docs'], { command: 'c', url: 'https://x.example/mcp' })).equal(2);
    should(err()).containEql('a --command or a --url, not both');
  });

  it('should change nothing on --dry-run', async () => {
    const { kernel, run, out } = harness();
    should(await run('add', ['docs'], { file: 'x', 'dry-run': true })).equal(0);
    should(out()).equal('Would add MCP server docs (mcp/docs.yaml).\n');
    should(writes(kernel)).eql([]);
  });

  it('should print the located problems of a refused write and exit 1, never the text it sent', async () => {
    const { run, err } = harness({ readText: async () => 'BAD: key\n' });
    should(await run('add', ['docs'], { file: 'x' })).equal(1);
    should(err()).containEql('mcp/docs.yaml:2:3 error: unknown key').and.containEql('fix: remove it');
    should(err()).containEql('the file does not check (1 problem); nothing was written');
    should(err()).not.containEql('BAD');
  });

  it('should say a write held for the owner is held, and name the command that confirms it', async () => {
    const { kernel, run, out } = harness();
    kernel.held = true;
    should(await run('add', ['docs'], { file: 'x' })).equal(0);
    should(out())
      .containEql('waits for your confirmation: it loosens')
      .and.containEql('fy config confirm mcp/docs.yaml');
  });
});

describe('edit', () => {
  const existing =
    '# yaml-language-server: $schema=../.schema/mcp--item.json\n# the owner wrote this\ncommand: old-server\nargs:\n  - --a\nenv:\n  KEEP: kept\n  TOKEN: ‹hidden›\n';

  it('should set only the keys given, keeping comments, the other env values and a hidden one', async () => {
    const { kernel, run, out } = harness();
    kernel.files.set('mcp/docs.yaml', existing);
    should(await run('edit', ['docs'], { command: 'new-server', env: ['REGION=eu'], yes: true })).equal(0);
    should(out()).equal('Changed MCP server docs.\n');
    const text = kernel.files.get('mcp/docs.yaml') as string;
    should(text).containEql('# the owner wrote this').and.containEql('command: new-server').and.containEql('--a');
    should(text).containEql('KEEP: kept').and.containEql('TOKEN: ‹hidden›').and.containEql('REGION: eu');
  });

  it('should turn a command item into a url item, dropping the command and its args', async () => {
    const { kernel, run } = harness();
    kernel.files.set('mcp/docs.yaml', existing);
    should(await run('edit', ['docs'], { url: 'https://docs.example/mcp', yes: true })).equal(0);
    const text = kernel.files.get('mcp/docs.yaml') as string;
    should(text).containEql('url: https://docs.example/mcp');
    should(text).not.containEql('command:');
    should(text).not.containEql('args:');
  });

  it('should refuse an item that does not exist, naming add', async () => {
    const { run, err } = harness();
    should(await run('edit', ['docs'], { command: 'x', yes: true })).equal(1);
    should(err()).containEql('There is no MCP server docs to edit. Add it with `fy mcp add docs`.');
  });

  it('should write nothing when the edit changes nothing', async () => {
    const { kernel, run, out } = harness();
    kernel.files.set('mcp/docs.yaml', existing);
    should(await run('edit', ['docs'], { command: 'old-server', yes: true })).equal(0);
    should(out()).containEql('is already like that; nothing was changed');
    should(writes(kernel)).eql([]);
  });

  it('should not go ahead without --yes unless the person says yes at the terminal', async () => {
    const declined = harness();
    declined.kernel.files.set('mcp/docs.yaml', existing);
    should(await declined.run('edit', ['docs'], { command: 'x' })).equal(1);
    should(declined.err()).containEql('Nothing was changed; run it again with --yes to go ahead.');
    should(writes(declined.kernel)).eql([]);

    const asked: string[] = [];
    const accepted = harness({
      confirm: async question => {
        asked.push(question);
        return true;
      },
    });
    accepted.kernel.files.set('mcp/docs.yaml', existing);
    should(await accepted.run('edit', ['docs'], { command: 'x' })).equal(0);
    should(asked[0]).containEql('Change MCP server docs? Every profile and runtime that uses it changes too.');
  });

  it('should report a file that moved since it was read as the daemon said it, not as a success', async () => {
    const { kernel, run } = harness();
    kernel.files.set('mcp/docs.yaml', existing);
    const original = kernel.call.bind(kernel);
    let reads = 0;
    kernel.call = (async (route: string, init?: never) => {
      const answer = await original(route, init);
      if (route === 'GET /v1/config/file') {
        reads += 1;
        if (reads === 1) (kernel as unknown as { version: number }).version += 1;
      }
      return answer;
    }) as never;
    let error: unknown;
    try {
      await run('edit', ['docs'], { command: 'x', yes: true });
    } catch (cause) {
      error = cause;
    }
    should((error as Refusal).status).equal(409);
  });
});

describe('rm', () => {
  it('should remove the item against the etag it read, after --yes', async () => {
    const { kernel, run, out } = harness();
    kernel.files.set('mcp/docs.yaml', 'command: a\n');
    should(await run('rm', ['docs'], { yes: true })).equal(0);
    should(out()).equal('Removed MCP server docs.\n');
    should(kernel.files.has('mcp/docs.yaml')).equal(false);
    should(writes(kernel)[0]?.init).eql({ query: { path: 'mcp/docs.yaml', etag: 'etag-mcp/docs.yaml-0' } });
  });

  it('should ask first, and remove nothing when not confirmed', async () => {
    const { kernel, run, err } = harness();
    kernel.files.set('mcp/docs.yaml', 'command: a\n');
    should(await run('rm', ['docs'])).equal(1);
    should(err()).containEql('Remove MCP server docs?');
    should(kernel.files.has('mcp/docs.yaml')).equal(true);
  });

  it('should refuse --remove-from-profiles rather than ignore it, before reading anything', async () => {
    const { kernel, run, err } = harness();
    should(await run('rm', ['docs'], { 'remove-from-profiles': true, yes: true })).equal(2);
    should(err()).containEql('--remove-from-profiles is not available yet');
    should(kernel.calls).eql([]);
  });

  it('should name an item that does not exist', async () => {
    const { run, err } = harness();
    should(await run('rm', ['docs'], { yes: true })).equal(1);
    should(err()).containEql('There is no MCP server docs.');
  });
});
