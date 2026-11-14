import { describe, expect, it } from 'bun:test';
import type { CliContext, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { fakeConfigDaemon } from '@ferretry/kernel/testing';
import cli from '../../../cli/index.ts';
import { McpItemSchema } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

/** The MCP cli half over a scripted daemon holding the kernel's config files. */
function world(files: Record<string, string> = {}) {
  const daemon = fakeConfigDaemon(files);
  const out: string[] = [];
  const err: string[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const ctx = { manifest, client: { ...daemon.client, subscribe: () => () => undefined }, io } as unknown as CliContext<
    typeof manifest
  >;
  const verbs = cli.build?.(ctx)?.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  const run = async (verb: string, args: string[], options: VerbInvocation['options'] = {}) =>
    await verbs[verb]!({ args, options });
  return { daemon, run, say: () => out.join(''), complain: () => err.join('') };
}

describe('fy mcp add | show | edit | rm: the MCP server items, over the kernel config routes (V-0182…V-0187)', () => {
  it('declares every item verb and none of them answers the not-served sentence', async () => {
    const declared: readonly string[] = manifest.actions.cli.map(entry => entry.verb);
    for (const verb of ['mcp add', 'mcp show', 'mcp edit', 'mcp rm']) expect(declared).toContain(verb);
    const { run, complain } = world();
    expect(await run('mcp show', ['nothing'])).toBe(1);
    expect(complain()).not.toMatch(/not served/);
  });

  it('adds a command server as config/mcp/<name>.yaml that the plugin’s own schema accepts', async () => {
    const { run, daemon, say } = world();
    const code = await run('mcp add', ['github'], {
      command: 'npx',
      arg: ['-y', '@modelcontextprotocol/server-github'],
      env: ['GITHUB_TOKEN=${secret:GITHUB_TOKEN}'],
      harness: 'claude',
    });
    expect(code).toBe(0);
    expect(say()).toContain('Added MCP server github.');
    const written = Bun.YAML.parse(daemon.files.get('mcp/github.yaml')!);
    expect(McpItemSchema.parse(written)).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${secret:GITHUB_TOKEN}' },
      harness: 'claude-code',
    });
  });

  it('adds an address server, and refuses one with neither a command nor an address', async () => {
    const ok = world();
    expect(await ok.run('mcp add', ['docs'], { url: 'https://docs.example.com/mcp' })).toBe(0);
    expect(McpItemSchema.parse(Bun.YAML.parse(ok.daemon.files.get('mcp/docs.yaml')!))).toEqual({
      url: 'https://docs.example.com/mcp',
    });
    const empty = world();
    expect(await empty.run('mcp add', ['nothing'], {})).toBe(1);
    expect(empty.complain()).toBe('An MCP server needs a --command to start or a --url to reach.\n');
    expect(empty.daemon.files.size).toBe(0);
  });

  it('refuses a malformed --env pair in words, and a name already taken', async () => {
    const bad = world();
    expect(await bad.run('mcp add', ['x'], { command: 'a', env: ['NOEQUALS'] })).toBe(1);
    expect(bad.complain()).toBe('--env takes NAME=value, got "NOEQUALS".\n');
    const taken = world({ 'mcp/github.yaml': 'command: npx\n' });
    expect(await taken.run('mcp add', ['github'], { command: 'b' })).toBe(1);
    expect(taken.complain()).toBe('github is already a MCP server. Change it with `fy mcp edit github`.\n');
  });

  it('shows a server and where it is used, as words and as JSON', async () => {
    const files = {
      'mcp/github.yaml':
        'command: npx\nargs:\n  - -y\n  - server-github\nenv:\n  GITHUB_TOKEN: ${secret:GITHUB_TOKEN}\n',
      'profiles/work.yaml': 'contents:\n  - mcp/github\n',
      'runtimes/claude-work.yaml': 'login: a\nprofile: work\n',
    };
    const words = world(files);
    expect(await words.run('mcp show', ['github'])).toBe(0);
    expect(words.say()).toBe(
      [
        'mcp/github',
        '  Runs: npx -y server-github',
        '  Env: GITHUB_TOKEN=${secret:GITHUB_TOKEN}',
        '  Used by profiles: work',
        '  Used by runtimes: claude-work',
        '  Changing it changes 1 profile and 1 runtime. Running sessions keep the old version until restarted.',
        '',
      ].join('\n'),
    );
    const json = world(files);
    expect(await json.run('mcp show', ['github'], { json: true })).toBe(0);
    expect(JSON.parse(json.say()).usedBy.runtimes).toEqual(['claude-work']);
  });

  it('edits one flag and keeps the rest, the owner’s comment and every variable it was not told about', async () => {
    const { run, daemon, say } = world({
      'mcp/github.yaml': '# the github server\ncommand: npx\nenv:\n  A: one # first\n',
    });
    expect(await run('mcp edit', ['github'], { env: ['B=two'], yes: true })).toBe(0);
    expect(say()).toContain('Changed MCP server github.');
    const text = daemon.files.get('mcp/github.yaml')!;
    expect(text).toContain('# the github server');
    expect(text).toContain('A: one # first');
    expect(McpItemSchema.parse(Bun.YAML.parse(text))).toEqual({ command: 'npx', env: { A: 'one', B: 'two' } });
  });

  it('moves a server from a command to an address by dropping what belonged to the command', async () => {
    const { run, daemon } = world({ 'mcp/github.yaml': 'command: npx\nargs:\n  - a\nenv:\n  A: one\n' });
    expect(await run('mcp edit', ['github'], { url: 'https://example.com/mcp', yes: true })).toBe(0);
    expect(McpItemSchema.parse(Bun.YAML.parse(daemon.files.get('mcp/github.yaml')!))).toEqual({
      url: 'https://example.com/mcp',
    });
  });

  it('will not change or remove anything without a yes, and says so', async () => {
    const { run, daemon, complain } = world({ 'mcp/github.yaml': 'command: npx\n' });
    expect(await run('mcp edit', ['github'], { command: 'node' })).toBe(1);
    expect(await run('mcp rm', ['github'])).toBe(1);
    expect(complain()).toContain('Nothing was changed: this needs a yes.');
    expect(daemon.files.get('mcp/github.yaml')).toBe('command: npx\n');
  });

  it('removes a server nothing uses, and refuses one a profile uses until it is taken out of the profile', async () => {
    const files = {
      'mcp/github.yaml': 'command: npx\n',
      'mcp/other.yaml': 'command: node\n',
      'profiles/work.yaml': 'contents:\n  - mcp/github\n  - mcp/other\n',
    };
    const refused = world(files);
    expect(await refused.run('mcp rm', ['github'], { yes: true })).toBe(1);
    expect(refused.complain()).toBe(
      'MCP server github is a layer in work. Remove it from those first, or add --remove-from-profiles.\n',
    );
    const taken = world(files);
    expect(await taken.run('mcp rm', ['github'], { yes: true, 'remove-from-profiles': true })).toBe(0);
    expect(taken.daemon.files.has('mcp/github.yaml')).toBe(false);
    expect(taken.daemon.files.get('profiles/work.yaml')).toBe('contents:\n  - mcp/other\n');
    const free = world(files);
    expect(await free.run('mcp rm', ['other'], { yes: true, 'remove-from-profiles': true })).toBe(0);
  });
});
