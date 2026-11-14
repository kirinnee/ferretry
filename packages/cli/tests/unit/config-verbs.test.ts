/**
 * `fy config check|path|schema|status|show|write|confirm|guide` (triage B06; parity rows V-0189 … V-0197), and the three
 * component item-verb families the real plugin halves now compose (`fy mcp add|show|edit|rm`, `fy harness claude-code
 * settings|hooks …`, `fy harness codex settings …`), each through the shell's REAL verb table over a fake daemon that
 * answers the kernel's configuration routes. No real home, no network.
 */
import { describe, it } from 'bun:test';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { createPluginHost } from '../../src/adapters/plugin-host.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

class RoutedTransport extends RecordingTransport {
  constructor(private readonly answers: Record<string, DaemonReply>) {
    super();
  }
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    return (
      this.answers[`${request.method} ${request.path.split('?')[0] as string}`] ?? {
        status: 404,
        body: { error: 'nothing here' },
      }
    );
  }
}

const DIRECTORY = '/fake-home/config';

const STATUS = (over: Record<string, unknown> = {}): DaemonReply => ({
  status: 200,
  body: {
    directory: DIRECTORY,
    files: [
      { path: 'warden.yaml', kind: 'warden', schema: 'warden.json', state: 'ok' },
      { path: 'runtimes/main.yaml', kind: 'runtimes', schema: 'runtimes--item.json', state: 'ok' },
      { path: 'mcp/docs.yaml', kind: 'mcp', schema: 'mcp--item.json', state: 'ok' },
    ],
    issues: [],
    pending: [],
    ...over,
  },
});

const world = (answers: Record<string, DaemonReply>, files: Record<string, string> = {}, stdin = '') => {
  const transport = new RoutedTransport(answers);
  const host = createPluginHost({
    home: '/fake-home',
    fs: state.createMemoryHostFs(),
    cwd: () => '/fake-cwd',
    readFile: async path => {
      const found = files[path];
      if (found === undefined) throw new Error(`no such file ${path}`);
      return found;
    },
    readStdin: async () => stdin,
    readBytes: async path => new TextEncoder().encode(files[path] ?? ''),
    readStdinBytes: async () => new TextEncoder().encode(stdin),
    pathExists: async path => path in files,
  });
  const made = fakeWorld({
    registry,
    inventory: {
      protocol: 'x' as never,
      plugins: [
        { id: 'kernel', on: true, contract: registry.kernel.contract },
        ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
      ],
    },
    transport,
    host,
  });
  return { ...made, transport };
};

const FILE = (over: Record<string, unknown> = {}): DaemonReply => ({
  status: 200,
  body: {
    path: 'warden.yaml',
    absolutePath: `${DIRECTORY}/warden.yaml`,
    exists: true,
    text: 'enabled: true\n',
    etag: 'abc123',
    state: 'ok',
    issues: [],
    ...over,
  },
});

describe('fy config check (V-0190)', () => {
  it('V-0190 should say a clean machine in v4’s summary line and exit 0', async () => {
    const { world: w, io } = world({ 'GET /v1/config/status': STATUS() });
    should(await runFy(['config', 'check'], w)).equal(0);
    should(io.stdout().trim()).equal('3 files checked: 0 errors, 0 warnings, 0 waiting for confirmation.');
  });

  it('should list each problem as path:line:col with its fix, and exit 1 on an error', async () => {
    const { world: w, io } = world({
      'GET /v1/config/status': STATUS({
        issues: [
          {
            path: 'warden.yaml',
            line: 3,
            column: 5,
            severity: 'error',
            message: 'unknown key "layer"',
            fix: 'did you mean layers?',
          },
          { path: 'voice.yaml', severity: 'warning', message: 'names a secret this machine does not hold' },
        ],
      }),
    });
    should(await runFy(['config', 'check'], w)).equal(1);
    should(io.stdout()).containEql('warden.yaml:3:5 error: unknown key "layer"\n  fix: did you mean layers?');
    should(io.stdout()).containEql('voice.yaml warning: names a secret this machine does not hold');
    should(io.stdout()).containEql('1 error, 1 warning');
  });

  it('should exit 0 when there are only warnings, and name every held edit with the command that confirms it', async () => {
    const { world: w, io } = world({
      'GET /v1/config/status': STATUS({
        issues: [{ path: 'voice.yaml', severity: 'warning', message: 'w', fix: 'f' }],
        pending: [{ path: 'warden.yaml', etag: 'e1', changes: ['the Warden may act alone'] }],
      }),
    });
    should(await runFy(['config', 'check'], w)).equal(0);
    should(io.stdout()).containEql(
      'warden.yaml waits for your confirmation: the Warden may act alone\n  confirm: fy config confirm warden.yaml',
    );
  });

  it('should be what a bare `fy config` runs (v4: check is the default)', async () => {
    const { world: w, io } = world({ 'GET /v1/config/status': STATUS() });
    should(await runFy(['config'], w)).equal(0);
    should(io.stdout()).containEql('3 files checked');
  });

  it('should print the report as JSON on --json', async () => {
    const { world: w, io } = world({ 'GET /v1/config/status': STATUS() });
    should(await runFy(['config', 'check', '--json'], w)).equal(0);
    should(JSON.parse(io.stdout())).eql({ files: 3, issues: [], pending: [] });
  });
});

describe('fy config status / path / schema (V-0196, V-0193, V-0194)', () => {
  it('V-0196 should print the directory then the report for `status`, and the payload on --json', async () => {
    const { world: w, io } = world({ 'GET /v1/config/status': STATUS() });
    should(await runFy(['config', 'status'], w)).equal(0);
    should(io.stdout().split('\n')[0]).equal(DIRECTORY);
    const json = world({ 'GET /v1/config/status': STATUS() });
    await runFy(['config', 'status', '--json'], json.world);
    should(JSON.parse(json.io.stdout()).directory).equal(DIRECTORY);
  });

  it('V-0193 should print the directory, or one file in it, for `path`', async () => {
    const answers = { 'GET /v1/config/status': STATUS() };
    const dir = world(answers);
    should(await runFy(['config', 'path'], dir.world)).equal(0);
    should(dir.io.stdout()).equal(`${DIRECTORY}\n`);
    const file = world(answers);
    should(await runFy(['config', 'path', 'logins/work.yaml'], file.world)).equal(0);
    should(file.io.stdout()).equal(`${DIRECTORY}/logins/work.yaml\n`);
  });

  it('should refuse a path that leaves the directory or is not a yaml file', async () => {
    for (const bad of ['../machine.yaml', '/etc/passwd', 'notes.txt']) {
      const { world: w, io } = world({ 'GET /v1/config/status': STATUS() });
      should(await runFy(['config', 'path', bad], w)).equal(1);
      should(io.stderr()).containEql('is not a Ferretry configuration file');
    }
  });

  it('V-0194 should list the schemas the daemon publishes, and print one by name or by a file it checks', async () => {
    const answers = { 'GET /v1/config/status': STATUS() };
    const files = {
      [`${DIRECTORY}/.schema/runtimes--item.json`]: '{"title":"runtime"}\n',
      [`${DIRECTORY}/.schema/warden.json`]: '{"title":"warden"}\n',
    };
    const list = world(answers, files);
    should(await runFy(['config', 'schema'], list.world)).equal(0);
    should(list.io.stdout()).containEql('runtimes--item  (runtimes)').and.containEql('warden  (warden)');
    const byName = world(answers, files);
    should(await runFy(['config', 'schema', 'runtimes--item'], byName.world)).equal(0);
    should(byName.io.stdout()).equal('{"title":"runtime"}\n');
    const byFile = world(answers, files);
    should(await runFy(['config', 'schema', 'warden.yaml'], byFile.world)).equal(0);
    should(byFile.io.stdout()).equal('{"title":"warden"}\n');
  });

  it('should name an unknown schema and exit 1', async () => {
    const { world: w, io } = world({ 'GET /v1/config/status': STATUS() });
    should(await runFy(['config', 'schema', 'nope'], w)).equal(1);
    should(io.stderr()).containEql('no schema nope: run `fy config schema` for the list');
  });
});

describe('fy config show (V-0195)', () => {
  it('V-0195 should print where the file stands, its etag, its issues and its text', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/config/file': FILE({
        issues: [
          {
            path: 'warden.yaml',
            line: 1,
            column: 1,
            severity: 'warning',
            message: 'a value is hidden',
            fix: 'use a secret',
          },
        ],
      }),
    });
    should(await runFy(['config', 'show', 'warden.yaml'], w)).equal(0);
    should(io.stdout()).containEql(`${DIRECTORY}/warden.yaml (ok)`).and.containEql('etag: abc123');
    should(io.stdout()).containEql('warden.yaml:1:1 warning: a value is hidden').and.containEql('enabled: true');
    should(transport.sent[0]?.path).containEql('path=warden.yaml');
  });

  it('should say a file that does not exist yet begins as the starter, and print JSON on --json', async () => {
    const missing = world({ 'GET /v1/config/file': FILE({ exists: false, text: '# starter\n' }) });
    await runFy(['config', 'show', 'warden.yaml'], missing.world);
    should(missing.io.stdout()).containEql('does not exist yet — this is the starter a new one begins with');
    const json = world({ 'GET /v1/config/file': FILE() });
    await runFy(['config', 'show', 'warden.yaml', '--json'], json.world);
    should(JSON.parse(json.io.stdout()).etag).equal('abc123');
  });
});

describe('fy config write (V-0197)', () => {
  it('V-0197 should send the stdin text with --if-match as the etag, and say it is in effect', async () => {
    const {
      world: w,
      io,
      transport,
    } = world(
      { 'PUT /v1/config/file': { status: 200, body: { path: 'warden.yaml', etag: 'new1', outcome: 'applied' } } },
      {},
      'enabled: false\n',
    );
    should(await runFy(['config', 'write', 'warden.yaml', '--if-match', 'abc123'], w)).equal(0);
    should(io.stdout()).equal('Wrote warden.yaml; it is in effect (etag new1).\n');
    should(transport.sent[0]?.method).equal('PUT');
    should(transport.sent[0]?.body).eql({ path: 'warden.yaml', text: 'enabled: false\n', etag: 'abc123' });
  });

  it('should send no etag when none was given', async () => {
    const { world: w, transport } = world(
      { 'PUT /v1/config/file': { status: 200, body: { path: 'warden.yaml', etag: 'new1', outcome: 'applied' } } },
      {},
      'x: 1\n',
    );
    await runFy(['config', 'write', 'warden.yaml'], w);
    should(transport.sent[0]?.body).eql({ path: 'warden.yaml', text: 'x: 1\n' });
  });

  it('should say a held write waits for the owner and name the confirm command', async () => {
    const { world: w, io } = world(
      {
        'PUT /v1/config/file': {
          status: 200,
          body: {
            path: 'warden.yaml',
            etag: 'new1',
            outcome: 'pending',
            pending: { path: 'warden.yaml', etag: 'new1', changes: ['the Warden may act alone'] },
          },
        },
      },
      {},
      'x: 1\n',
    );
    should(await runFy(['config', 'write', 'warden.yaml'], w)).equal(0);
    should(io.stdout())
      .containEql('it waits for your confirmation: the Warden may act alone')
      .and.containEql('fy config confirm warden.yaml');
  });

  it('should print the located problems of a refused write, then its sentence, and exit 1', async () => {
    const { world: w, io } = world(
      {
        'PUT /v1/config/file': {
          status: 422,
          body: {
            error: 'the file does not check (1 problem); nothing was written',
            code: 'config_invalid',
            issues: [
              { path: 'warden.yaml', line: 2, column: 1, severity: 'error', message: 'unknown key', fix: 'remove it' },
            ],
          },
        },
      },
      {},
      'bad: 1\n',
    );
    should(await runFy(['config', 'write', 'warden.yaml'], w)).equal(1);
    should(io.stderr())
      .containEql('warden.yaml:2:1 error: unknown key\n  fix: remove it')
      .and.containEql('nothing was written');
  });

  it('should surface a stale etag as the daemon’s own sentence', async () => {
    const { world: w, io } = world(
      {
        'PUT /v1/config/file': {
          status: 409,
          body: {
            error: 'warden.yaml changed since it was read; read it again and redo the edit',
            code: 'config_conflict',
          },
        },
      },
      {},
      'x: 1\n',
    );
    should(await runFy(['config', 'write', 'warden.yaml', '--if-match', 'old'], w)).equal(1);
    should(io.stderr()).containEql('changed since it was read');
  });
});

describe('fy config confirm (V-0191)', () => {
  const HELD = { pending: [{ path: 'warden.yaml', etag: 'e1', changes: ['the Warden may act alone'] }] };

  it('should list what waits when no file is named, and say when nothing does', async () => {
    const waiting = world({ 'GET /v1/config/status': STATUS(HELD) });
    should(await runFy(['config', 'confirm'], waiting.world)).equal(0);
    should(waiting.io.stdout()).containEql('warden.yaml waits for your confirmation');
    const none = world({ 'GET /v1/config/status': STATUS() });
    await runFy(['config', 'confirm'], none.world);
    should(none.io.stdout()).equal('Nothing is waiting for your confirmation.\n');
  });

  it('V-0191 should confirm the edit by the etag that was reviewed', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/config/status': STATUS(HELD),
      'POST /v1/config/confirm': { status: 200, body: { path: 'warden.yaml', confirmed: true } },
    });
    should(await runFy(['config', 'confirm', 'warden.yaml'], w)).equal(0);
    should(io.stdout()).equal('Confirmed warden.yaml: the Warden may act alone. It is in effect now.\n');
    const post = transport.sent.find(request => request.method === 'POST');
    should(post?.body).eql({ path: 'warden.yaml', etag: 'e1' });
  });

  it('should say a file with nothing waiting, and a change that moved again, as v4 did', async () => {
    const nothing = world({ 'GET /v1/config/status': STATUS() });
    should(await runFy(['config', 'confirm', 'warden.yaml'], nothing.world)).equal(1);
    should(nothing.io.stderr()).containEql('warden.yaml has no change waiting for your confirmation');
    const moved = world({
      'GET /v1/config/status': STATUS(HELD),
      'POST /v1/config/confirm': { status: 200, body: { path: 'warden.yaml', confirmed: false } },
    });
    should(await runFy(['config', 'confirm', 'warden.yaml'], moved.world)).equal(1);
    should(moved.io.stderr()).containEql('changed again before it could be confirmed; run fy config confirm again');
  });
});

describe('fy config guide (V-0192)', () => {
  it('V-0192 should print the Set up Ferretry skill as a SKILL.md for this binary, asking the daemon for nothing', async () => {
    const { world: w, io, transport } = world({});
    should(await runFy(['config', 'guide'], w)).equal(0);
    const guide = io.stdout();
    should(guide).startWith('---\nname: set-up-ferretry\n');
    should(guide)
      .containEql('`fy config check`')
      .and.containEql('`fy config confirm <file>`')
      .and.containEql('`fy secret set NAME`');
    should(guide).containEql('Never write a secret value into a file');
    should(transport.sent).deepEqual([]);
  });
});

describe('the component item verbs (V-0183 … V-0187)', () => {
  const MCP_FILE = (over: Record<string, unknown> = {}): DaemonReply =>
    FILE({ path: 'mcp/docs.yaml', exists: true, text: 'command: docs-server\n', etag: 'm1', ...over });

  it('should add an MCP server from flags through PUT /v1/config/file against the etag it read', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/config/file': MCP_FILE({
        exists: false,
        text: '# yaml-language-server: $schema=../.schema/mcp--item.json\n',
      }),
      'PUT /v1/config/file': { status: 200, body: { path: 'mcp/docs.yaml', etag: 'm2', outcome: 'applied' } },
    });
    should(await runFy(['mcp', 'add', 'docs', '--command', 'docs-server', '--arg=--stdio'], w)).equal(0);
    should(io.stdout()).equal('Added MCP server docs.\n');
    const put = transport.sent.find(request => request.method === 'PUT');
    const body = put?.body as { path: string; text: string; etag: string };
    should(body.path).equal('mcp/docs.yaml');
    should(body.etag).equal('m1');
    should(body.text).containEql('command: docs-server').and.containEql('--stdio');
  });

  it('should show one MCP server and remove it with the etag it read (DELETE ?path&etag), after --yes', async () => {
    const shown = world({ 'GET /v1/config/file': MCP_FILE() });
    should(await runFy(['mcp', 'show', 'docs'], shown.world)).equal(0);
    should(shown.io.stdout()).containEql('command: docs-server');
    const removed = world({
      'GET /v1/config/file': MCP_FILE(),
      'DELETE /v1/config/file': { status: 200, body: { path: 'mcp/docs.yaml', etag: 'm1', outcome: 'removed' } },
    });
    should(await runFy(['mcp', 'rm', 'docs', '--yes'], removed.world)).equal(0);
    const del = removed.transport.sent.find(request => request.method === 'DELETE');
    should(del?.path).containEql('path=mcp%2Fdocs.yaml').and.containEql('etag=m1');
  });

  it('should drive Claude Code settings and hooks, and Codex settings, over their own collections', async () => {
    const cases: [string[], string][] = [
      [['harness', 'claude-code', 'settings', 'show', 'fast'], 'claude-code/settings/fast.yaml'],
      [['harness', 'claude-code', 'hooks', 'show', 'guard'], 'claude-code/hooks/guard.yaml'],
      [['harness', 'codex', 'settings', 'show', 'fast'], 'codex/settings/fast.yaml'],
    ];
    for (const [words, path] of cases) {
      const { world: w, io, transport } = world({ 'GET /v1/config/file': FILE({ path, text: 'settings: {}\n' }) });
      should(await runFy(words, w)).equal(0);
      should(decodeURIComponent(transport.sent[0]?.path ?? '')).containEql(`path=${path}`);
      should(io.stdout()).containEql('settings: {}');
    }
  });

  it('should add Codex settings from --file, and list Claude Code hooks items only from their own folder', async () => {
    const added = world(
      {
        'GET /v1/config/file': FILE({
          path: 'codex/settings/fast.yaml',
          exists: false,
          text: '# starter\n',
          etag: 'c1',
        }),
        'PUT /v1/config/file': {
          status: 200,
          body: { path: 'codex/settings/fast.yaml', etag: 'c2', outcome: 'applied' },
        },
      },
      { '/fake-cwd/fast.yaml': 'settings:\n  model: gpt\n', 'fast.yaml': 'settings:\n  model: gpt\n' },
    );
    should(await runFy(['harness', 'codex', 'settings', 'add', 'fast', '--file', 'fast.yaml'], added.world)).equal(0);
    const listed = world({
      'GET /v1/config/status': STATUS({
        files: [
          { path: 'claude-code/hooks/guard.yaml', kind: 'claude-code', schema: 'x.json', state: 'ok' },
          { path: 'claude-code/settings/fast.yaml', kind: 'claude-code', schema: 'y.json', state: 'ok' },
        ],
      }),
    });
    should(await runFy(['harness', 'claude-code', 'hooks', 'ls'], listed.world)).equal(0);
    should(listed.io.stdout()).equal('guard\n');
  });

  it('should refuse the settings flags v5’s settings items do not hold, rather than ignore them', async () => {
    const { world: w, io, transport } = world({});
    const code = await runFy(['harness', 'claude-code', 'settings', 'add', 'fast', '--env', 'A=b'], w);
    should(code).equal(2);
    should(io.stderr()).containEql('A Claude Code settings item has no --env: --file <path>.');
    should(transport.sent).deepEqual([]);
  });
});
