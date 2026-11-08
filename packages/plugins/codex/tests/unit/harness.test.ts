import { describe, it } from 'bun:test';
import type { Runner, RunSpec, LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import should from 'should';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { realClock } from '../support/ports.ts';
import { tomlString, tomlTables } from '../../daemon/lib/index.ts';

const FERRET = 'f1' as FerretId;
const HOME = '/state/codex/agent-homes/f1' as FencedPath;
const FOLDER = '/work/project' as FencedPath;

/** A ferret's home that remembers what was written into it, and which folders were made private. */
function fakeRoots() {
  const written = new Map<string, string>();
  const privateDirectories: string[] = [];
  const handle = {
    name: 'agent-homes',
    resolve: (relative: string) =>
      ok((relative.startsWith('/') ? relative : relative === '' ? HOME : `${HOME}/${relative}`) as FencedPath),
    list: async () => [],
    lstat: async () => undefined,
    makeDirectory: async () => undefined,
    entries: async () => [],
    stat: async () => undefined,
    writeText: async (path: FencedPath, text: string) => void written.set(path, text),
    ensurePrivateDirectory: async (path: FencedPath) => void privateDirectories.push(path),
  } as unknown as RootHandle;
  return { written, privateDirectories, roots: { root: () => handle } as unknown as KernelPorts['roots'] };
}

const specOf = (extra: Partial<LaunchSpec> = {}): LaunchSpec =>
  ({
    ferret: FERRET,
    name: 'f1',
    role: 'worker',
    harness: 'codex',
    folder: FOLDER,
    home: HOME,
    instructions: [],
    parts: [],
    ...extra,
  }) as unknown as LaunchSpec;

/** A runner that records the command it was given and succeeds. */
function fakeRunner() {
  const seen: { call: 'start' | 'resume'; spec: RunSpec; conversation?: string }[] = [];
  const running = { handle: '%1', startedAt: '2026-10-20T09:00:00.000Z' };
  const runner = {
    key: 'tmux',
    start: async (spec: RunSpec) => (seen.push({ call: 'start', spec }), ok(running)),
    resume: async (spec: RunSpec, conversation: string) => (
      seen.push({ call: 'resume', spec, conversation }), ok(running)
    ),
    stop: async () => undefined,
  } as unknown as Runner;
  return { runner, seen };
}

const harnessOver = (location: Awaited<ReturnType<NonNullable<Parameters<typeof codexHarness>[0]['locate']>>>) => {
  const { written, privateDirectories, roots } = fakeRoots();
  const harness = codexHarness({
    kernel: {
      roots,
      state: { write: async () => undefined } as never,
      log: undefined as never,
      clock: realClock(),
      redaction: { read: async fn => await fn({ text: (s: string) => s } as never) },
    },
    locate: async () => location,
    probe: {
      version: async () => ({ state: 'ok', version: '0.145.0' }),
      startup: async () => ({ ok: true }),
    },
    update: {
      view: async () => {
        throw new Error('not used');
      },
      start: async () => {
        throw new Error('not used');
      },
      settled: async () => undefined,
    },
  });
  return { harness, written, privateDirectories };
};

const LOCATED = {
  outcome: 'located',
  path: '/opt/bin/codex',
  rule: 'inherited environment',
  declaredBy: 'PATH',
} as const;
const ENV = {} as RunSpec['env'];

describe('the Codex harness', () => {
  it('is keyed codex and spends the sign-ins Codex can use', () => {
    const { harness } = harnessOver(LOCATED);
    should(harness.key).equal('codex');
    should(harness.accepts).containDeep(['openai', 'api-key']);
  });

  it('discovers the binary and its version, and says plainly when it is missing', async () => {
    should(await harnessOver(LOCATED).harness.discover()).eql({
      found: true,
      binary: '/opt/bin/codex',
      version: '0.145.0',
    });
    should(await harnessOver({ outcome: 'absent', searched: [] }).harness.discover()).eql({
      found: false,
      reason: 'codex was not found on this machine',
    });
    should(
      await harnessOver({
        outcome: 'override-absent',
        path: '/x',
        declaredBy: 'harness-codex.yaml binary',
        reason: 'cannot run it',
      }).harness.discover(),
    ).eql({ found: false, reason: 'cannot run it' });
  });

  it('writes AGENTS.md and config.toml inside the ferret’s home, and nothing when there is nothing to say', async () => {
    const { harness, written } = harnessOver(LOCATED);
    const empty = await harness.prepareHome(specOf());
    should(empty.files).eql([]);
    should(written.size).equal(0);

    const plan = await harness.prepareHome(
      specOf({
        parts: [
          { kind: 'instruction', id: 'i', text: 'be brief' },
          { kind: 'mcp', name: 'ferretry', config: { command: 'fy', args: ['mcp'] } },
        ],
      }),
    );
    should(plan.files).eql([`${HOME}/AGENTS.md`, `${HOME}/config.toml`]);
    should(written.get(`${HOME}/AGENTS.md`)).equal('be brief\n');
    should(written.get(`${HOME}/config.toml`)).equal('[mcp_servers.ferretry]\ncommand = "fy"\nargs = ["mcp"]\n');
  });

  it('starts Codex in the work folder with CODEX_HOME pointing at the ferret’s home', async () => {
    const { harness } = harnessOver(LOCATED);
    const { runner, seen } = fakeRunner();
    const started = await harness.start(specOf({ model: 'gpt-5.6-codex', prompt: 'hello' }), runner, ENV);
    should(started.ok).be.true();
    const command = seen[0]?.spec.command ?? [];
    should(command.slice(0, 3)).eql(['env', `CODEX_HOME=${HOME}`, '/opt/bin/codex']);
    should(command).containEql('gpt-5.6-codex');
    // The task reaches the agent once, as the turn-one pointer Ferrets types: never also on the argv.
    should(command).not.containEql('hello');
    should(seen[0]?.spec.cwd).equal(FOLDER);
    should(seen[0]?.call).equal('start');
  });

  it('launch-argv parity: a Codex start carries no read allowance for its hand-off folders, as today', async () => {
    // Today (rebuild-ref `packages/daemon/src/lib/session/send/handoff.ts:63-65`) `handoffReadArguments('codex', …)` is
    // `[]`: Codex's sandbox (`workspace-write`, `packages/fleet/src/lib/account/fixed-layer.ts:201`) reads anywhere and
    // limits only writes, so `buildLaunchArgv` (`launch/argv.ts:171`) added nothing. 5.0 hands Codex the same
    // `LaunchSpec.readable` Ferrets hands Claude, and its argv must not change for it.
    const { harness } = harnessOver(LOCATED);
    const plain = fakeRunner();
    const handed = fakeRunner();
    const readable = ['turns', 'channel', 'attachments'].map(
      folder => `/fy/state/ferrets/sessions/f1/${folder}` as FencedPath,
    );
    await harness.start(specOf(), plain.runner, ENV);
    await harness.start(specOf({ readable }), handed.runner, ENV);
    const command = handed.seen[0]?.spec.command ?? [];
    should(command).eql(plain.seen[0]?.spec.command);
    should(command.some(argument => argument.includes('allowedTools') || argument.includes('/fy/state/'))).be.false();
    should(command).containEql('sandbox_mode="workspace-write"');
  });

  it('resumes by the harness conversation id, and reports it back', async () => {
    const { harness } = harnessOver(LOCATED);
    const { runner, seen } = fakeRunner();
    const resumed = await harness.resume(specOf(), runner, ENV, 'conv-1');
    should(seen[0]).containDeep({ call: 'resume', conversation: 'conv-1' });
    should(seen[0]?.spec.command).containEql('resume');
    should(seen[0]?.spec.command).containEql('conv-1');
    should(resumed.ok && resumed.value.harnessConversation).equal('conv-1');
  });

  it('refuses to start when Codex cannot be found, and starts nothing', async () => {
    const { harness } = harnessOver({ outcome: 'absent', searched: [] });
    const { runner, seen } = fakeRunner();
    const started = await harness.start(specOf(), runner, ENV);
    should(started).eql({ ok: false, error: 'unavailable' });
    should(seen).eql([]);
  });

  it('leaves sending to Conversation: a delivery here is a refusal that says so', async () => {
    const { harness } = harnessOver(LOCATED);
    const delivery = await harness.deliver(FERRET, '%1' as never, { id: 'm1', text: 'hi' });
    should(delivery).containDeep({ status: 'refused', id: 'm1' });
  });
});

describe('writing Codex’s TOML', () => {
  it('quotes strings and escapes what TOML requires', () => {
    should(tomlString('a"b\\c\nd')).equal('"a\\"b\\\\c\\nd"');
  });

  it('writes one table per server, quoting a key that is not a bare word', () => {
    should(tomlTables('mcp_servers', { 'my server': { command: 'fy', env: { A: 'b' }, ignored: null } })).equal(
      '[mcp_servers."my server"]\ncommand = "fy"\nenv = { A = "b" }',
    );
  });
});
