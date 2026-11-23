import { afterAll, describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner, RunSpec, LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import should from 'should';
import { CODEX_OFFLINE_LAUNCH_ERROR, codexLaunchFailure } from '@ferretry/plugin-runtimes/contract';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { realClock } from '../support/ports.ts';
import { codexCompactPrompt, tomlString, tomlTables } from '../../daemon/lib/index.ts';
import { CODEX_LAUNCH_SETTINGS, CODEX_SETTINGS } from '../../contract/index.ts';
import { CODEX_QUESTIONS_FEATURE, CODEX_QUESTIONS_OFF, codexFixedArguments } from '../../daemon/lib/fixed-layer.ts';
import { selectEverything } from '../support/selected.ts';

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

const harnessOver = (
  location: Awaited<ReturnType<NonNullable<Parameters<typeof codexHarness>[0]['locate']>>>,
  /** The permission mode the config file says; absent means the harness file says nothing (the default applies). */
  permissionMode?: 'auto' | 'skip',
  /** A settings component the runtime selects (`config/codex/settings/`): its document is merged into `config.toml`. */
  settings?: Record<string, unknown>,
  /** The settings items (`config/codex/settings/`) in the config, with any launch flags they carry. */
  items: ReadonlyMap<string, unknown> = new Map(),
) => {
  const { written, privateDirectories, roots } = fakeRoots();
  /** The launch-settings records the launches wrote, in order. */
  const records: unknown[] = [];
  const harness = codexHarness({
    selected: selectEverything,
    kernel: {
      roots,
      state: {
        // Only the launch-settings record is of interest: the rollouts write their own beside it.
        write: async (definition: unknown, record: unknown) => {
          if (definition === CODEX_LAUNCH_SETTINGS) records.push(record);
        },
      } as never,
      log: { warn: () => undefined } as never,
      clock: realClock(),
      redaction: { read: async fn => await fn({ text: (s: string) => s } as never) },
      config: {
        collection: (definition: unknown) =>
          definition === CODEX_SETTINGS
            ? new Map<string, unknown>([
                ...items,
                ...(settings === undefined ? [] : [['features', { settings }] as const]),
              ])
            : new Map(),
      } as never,
    },
    ...(permissionMode === undefined ? {} : { permissionMode: () => permissionMode }),
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
  return { harness, written, privateDirectories, records };
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

  it('writes AGENTS.md and config.toml inside the ferret’s home; with nothing to say only the update-prompt key', async () => {
    const { harness, written } = harnessOver(LOCATED);
    const empty = await harness.prepareHome(specOf());
    should(empty.files).eql([`${HOME}/config.toml`]);
    should([...written.keys()]).eql([`${HOME}/config.toml`]);
    should(written.get(`${HOME}/config.toml`)).equal('check_for_update_on_startup = false\n');

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
    should(written.get(`${HOME}/config.toml`)).equal(
      'check_for_update_on_startup = false\n\n[mcp_servers.ferretry]\ncommand = "fy"\nargs = ["mcp"]\n',
    );
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

  describe('the start’s fast mode (U0c)', () => {
    const tiers = (command: readonly string[]): string[] => command.filter(word => word.startsWith('service_tier='));

    it('a fast start puts the priority tier on the argv, a no-fast start the default one, and an unset one nothing', async () => {
      const { harness } = harnessOver(LOCATED);
      const { runner, seen } = fakeRunner();
      await harness.start(specOf({ options: { fast: true } }), runner, ENV);
      await harness.start(specOf({ options: { fast: false } }), runner, ENV);
      await harness.start(specOf({ options: { effort: 'high' } }), runner, ENV);
      await harness.start(specOf(), runner, ENV);
      const [fast, standard, unsetWithOptions, unset] = seen.map(call => call.spec.command);

      should(tiers(fast ?? [])).eql(['service_tier="priority"']);
      should(fast?.[(fast?.indexOf('service_tier="priority"') ?? 0) - 1]).equal('-c');
      should(tiers(standard ?? [])).eql(['service_tier="default"']);
      should(tiers(unsetWithOptions ?? [])).eql([]);
      should(tiers(unset ?? [])).eql([]);
    });

    it('a resume carries the recorded fast mode too, so a revived ferret keeps what it started with', async () => {
      const { harness } = harnessOver(LOCATED);
      const { runner, seen } = fakeRunner();
      await harness.resume(specOf({ options: { fast: true } }), runner, ENV, 'conv-1');
      await harness.resume(specOf(), runner, ENV, 'conv-1');

      should(seen.map(call => call.call)).eql(['resume', 'resume']);
      should(tiers(seen[0]?.spec.command ?? [])).eql(['service_tier="priority"']);
      should(tiers(seen[1]?.spec.command ?? [])).eql([]);
    });
  });

  it('hands Codex the compaction prompt on every start, so a compacted ferret re-reads its task and agenda', async () => {
    const { harness } = harnessOver(LOCATED);
    const { runner, seen } = fakeRunner();
    await harness.start(specOf({}), runner, ENV);
    const command = seen[0]?.spec.command ?? [];
    const at = command.indexOf(`compact_prompt=${tomlString(codexCompactPrompt(FERRET))}`);
    should(at).be.greaterThan(0);
    should(command[at - 1]).equal('-c');
  });

  it('launch-argv parity: a Codex start carries no read allowance for its hand-off folders, as today', async () => {
    // Today (rebuild-ref `packages/daemon/src/lib/session/send/handoff.ts:63-65`) `handoffReadArguments('codex', …)` is
    // `[]`: Codex's sandbox (`workspace-write`, `packages/fleet/src/lib/account/fixed-layer.ts:201`) reads anywhere and
    // limits only writes, so `buildLaunchArgv` (`launch/argv.ts:171`) added nothing. 5.0 hands Codex the same
    // `LaunchSpec.readable` Ferrets hands Claude, and its argv must not change for it.
    const { harness } = harnessOver(LOCATED, 'auto');
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

  describe('the settings items’ launch flags (any flag, owner decision ^A525)', () => {
    const items = new Map<string, unknown>([
      ['b-search', { settings: {}, flags: ['--search', '-c', 'model_verbosity="low"'] }],
      ['a-risky', { settings: {}, flags: ['--full-auto', '-c', 'approval_policy="never"', '--some-future-flag'] }],
    ]);

    it('reach the argv as separate words, in item name order, before the launch’s own arguments', async () => {
      const { harness } = harnessOver(LOCATED, 'auto', undefined, items);
      const { runner, seen } = fakeRunner();
      await harness.start(specOf({ model: 'gpt-5.6-codex' }), runner, ENV);
      const command = seen[0]?.spec.command ?? [];
      const at = command.indexOf('--some-future-flag');

      should(command.slice(at, at + 3)).eql(['--some-future-flag', '--search', '-cmodel_verbosity="low"']);
      should(at).be.below(command.indexOf('--model'));
      should(command.indexOf('--model')).be.below(command.indexOf('--no-alt-screen'));
    });

    it('lose to the launch on a permission switch: the item’s sandbox and approval flags never reach the argv', async () => {
      const { harness } = harnessOver(LOCATED, 'auto', undefined, items);
      const { runner, seen } = fakeRunner();
      await harness.start(specOf(), runner, ENV);
      const command = seen[0]?.spec.command ?? [];

      should(command).not.containEql('--full-auto');
      should(command).not.containEql('approval_policy="never"');
      should(command.filter(argument => argument.startsWith('approval_policy='))).eql(['approval_policy="on-request"']);
    });

    it('cannot loosen the launch: its permission is passed as explicit flags, exactly one of each, after the items’ flags', async () => {
      const spelled = new Map<string, unknown>([
        ['a', { settings: {}, flags: ['-sdanger-full-access', '-anever', '--yolo', '-pwork', '--some-future-flag'] }],
      ]);
      const { harness } = harnessOver(LOCATED, 'auto', undefined, spelled);
      const { runner, seen } = fakeRunner();
      await harness.start(specOf(), runner, ENV);
      const command = seen[0]?.spec.command ?? [];

      should(command.filter(word => /^(--ask-for-approval|--sandbox|-s|-a|-p|--yolo|--profile)/u.test(word))).eql([
        '--ask-for-approval=on-request',
        '--sandbox=workspace-write',
      ]);
      should(command.indexOf('--some-future-flag')).be.below(command.indexOf('--ask-for-approval=on-request'));
    });

    it('reach a resume too, after the conversation id', async () => {
      const { harness } = harnessOver(LOCATED, 'auto', undefined, items);
      const { runner, seen } = fakeRunner();
      await harness.resume(specOf(), runner, ENV, 'conv-1');
      const command = seen[0]?.spec.command ?? [];

      should(command.slice(command.indexOf('resume'), command.indexOf('resume') + 3)).eql([
        'resume',
        'conv-1',
        '--some-future-flag',
      ]);
    });

    it('add nothing when no item carries a flag', async () => {
      const { harness } = harnessOver(LOCATED, 'auto', undefined, new Map([['plain', { settings: { model: 'm' } }]]));
      const bare = harnessOver(LOCATED, 'auto');
      const withItem = fakeRunner();
      const without = fakeRunner();
      await harness.start(specOf(), withItem.runner, ENV);
      await bare.harness.start(specOf(), without.runner, ENV);

      should(withItem.seen[0]?.spec.command).eql(without.seen[0]?.spec.command);
    });
  });

  it('^A525 a harness file that says no permission mode launches Codex with approval never and the full-access sandbox', async () => {
    const { harness } = harnessOver(LOCATED);
    const started = fakeRunner();
    const resumed = fakeRunner();
    await harness.start(specOf(), started.runner, ENV);
    await harness.resume(specOf(), resumed.runner, ENV, 'conv-1');
    for (const command of [started.seen[0]?.spec.command ?? [], resumed.seen[0]?.spec.command ?? []]) {
      should(command).containEql('approval_policy="never"');
      should(command).containEql('sandbox_mode="danger-full-access"');
      should(command).not.containEql('approval_policy="on-request"');
      should(command).not.containEql('sandbox_mode="workspace-write"');
    }
  });

  it('^A525 an explicit auto keeps Codex asking: on-request and the workspace-write sandbox', async () => {
    const { harness } = harnessOver(LOCATED, 'auto');
    const { runner, seen } = fakeRunner();
    await harness.start(specOf(), runner, ENV);
    const command = seen[0]?.spec.command ?? [];
    should(command).containEql('approval_policy="on-request"');
    should(command).containEql('sandbox_mode="workspace-write"');
    should(command).not.containEql('approval_policy="never"');
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

  describe('the question tool (^A527, again 2026-11-17: no ferret ever gets request_user_input, and there is no setting to turn it on)', () => {
    const OFF = ['-c', 'features.default_mode_request_user_input=false'];
    const withFeature = (command: readonly string[]): boolean =>
      command.some((argument, at) => argument === '--enable' && command[at + 1] === 'default_mode_request_user_input');
    /** The OFF override, as an adjacent `-c` / `features.…=false` pair: counted, so a doubled one fails too. */
    const offCount = (command: readonly string[]): number =>
      command.filter((argument, at) => argument === OFF[0] && command[at + 1] === OFF[1]).length;

    for (const call of ['start', 'resume'] as const) {
      const launch = async (mode: 'interactive' | 'auto' | undefined, settings?: Record<string, unknown>) => {
        const { harness, records } = harnessOver(LOCATED, undefined, settings);
        const { runner, seen } = fakeRunner();
        const spec = specOf(mode === undefined ? {} : { mode });
        const launched =
          call === 'start' ? await harness.start(spec, runner, ENV) : await harness.resume(spec, runner, ENV, 'conv-1');
        should(launched.ok).be.true();
        return { command: seen[0]?.spec.command ?? [], records };
      };
      /** A selected settings component that switches the feature ON in `config.toml`. */
      const FEATURE_ON = { features: { default_mode_request_user_input: true } };

      it(`a ${call} never enables it, an interactive ferret included, and says OFF explicitly exactly once`, async () => {
        for (const mode of ['interactive', 'auto', undefined] as const) {
          const { command } = await launch(mode);
          should(withFeature(command)).be.false();
          should(command.includes('--enable')).be.false();
          should(offCount(command)).equal(1);
        }
      });

      it(`a ${call} overrides a selected settings component that turns the feature ON in config.toml`, async () => {
        // The launch names the OFF, which a `-c` override ranks above the config.toml the component fills (see below).
        for (const mode of ['interactive', 'auto', undefined] as const) {
          const { command } = await launch(mode, FEATURE_ON);
          should(offCount(command)).equal(1);
          should(withFeature(command)).be.false();
        }
      });

      it(`a ${call} records the same launch settings whatever the mode, so no ferret reads as outdated for it`, async () => {
        const interactive = await launch('interactive');
        const auto = await launch('auto');
        should(interactive.records).eql(auto.records);
        should(interactive.records.length).equal(1);
      });
    }

    it("writes a selected settings component's feature ON into config.toml unchanged: the launch OFF is what wins", async () => {
      const { harness, written } = harnessOver(LOCATED, undefined, {
        features: { default_mode_request_user_input: true },
      });
      await harness.prepareHome(specOf());
      const toml = [...written.entries()].find(([path]) => path.endsWith('config.toml'))?.[1] ?? '';
      should(toml).containEql('default_mode_request_user_input = true');
    });

    it('spells the OFF as a -c override of the one feature, and has no setting or helper that enables it', () => {
      should(CODEX_QUESTIONS_OFF).eql(OFF);
      should(CODEX_QUESTIONS_FEATURE).equal('default_mode_request_user_input');
    });

    it('is outside the fixed layer, whose fingerprint is the recorded launch: its arguments never carry it', () => {
      should(codexFixedArguments('auto', FOLDER).includes(CODEX_QUESTIONS_FEATURE)).be.false();
    });
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

  it('explains a start that died offline in its own fixed words (what Ferrets keeps as start_failed.explained), and the screen is never quoted', () => {
    const { harness } = harnessOver(LOCATED);

    const sentence = harness.startFailure?.('Error: FIXTURE_SECRET workspace routing discovery failed (ENETUNREACH)');

    should(sentence).equal(codexLaunchFailure('workspace routing discovery failed'));
    should(sentence?.startsWith(CODEX_OFFLINE_LAUNCH_ERROR)).be.true();
    should(sentence).not.containEql('FIXTURE_SECRET');
    should(harness.startFailure?.('error: unrecognised option')).be.undefined();
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

describe('SIT: a fake codex binary sees the fast tier a start and a revive were given (U0c)', () => {
  const scratch: string[] = [];
  afterAll(async () => {
    await Promise.all(scratch.map(async folder => await rm(folder, { recursive: true, force: true })));
  });

  /** A `codex` that writes each launch's argv, one word per line, to `argv.<n>` beside itself, then exits. */
  async function fakeCodex() {
    const folder = await mkdtemp(join(tmpdir(), 'ferretry-fake-codex-'));
    scratch.push(folder);
    const binary = join(folder, 'codex');
    await writeFile(
      binary,
      `#!/bin/sh\nn=$(ls "${folder}" | grep -c '^argv\\.')\nprintf '%s\\n' "$@" > "${folder}/argv.$n"\n`,
    );
    await chmod(binary, 0o755);
    return { binary, folder };
  }

  /** A runner that really runs the command it is given, as the terminals runner would in a pane. */
  const spawning = (): Runner => {
    const running = { handle: '%1', startedAt: '2026-10-20T09:00:00.000Z' };
    const run = async (spec: RunSpec) => {
      const child = Bun.spawn([...spec.command], { env: { PATH: process.env['PATH'] ?? '' }, stdout: 'ignore' });
      await child.exited;
      return ok(running);
    };
    return {
      key: 'tmux',
      start: run,
      resume: async (spec: RunSpec) => await run(spec),
      stop: async () => undefined,
    } as unknown as Runner;
  };

  const argvOf = async (folder: string, n: number): Promise<string[]> =>
    (await readFile(join(folder, `argv.${n}`), 'utf8')).split('\n').filter(word => word !== '');

  it('passes -c service_tier="priority" on a fast start and its revive, and nothing for a start that asked for nothing', async () => {
    const { binary, folder } = await fakeCodex();
    const { harness } = harnessOver({ ...LOCATED, path: binary });
    const runner = spawning();

    await harness.start(specOf({ options: { fast: true } }), runner, ENV);
    await harness.resume(specOf({ options: { fast: true } }), runner, ENV, 'conv-1');
    await harness.start(specOf(), runner, ENV);
    await harness.resume(specOf(), runner, ENV, 'conv-1');
    // The owner typed /fast off after the start: Ferrets hands the revive what the session is ON, which is false.
    await harness.resume(specOf({ options: { fast: false } }), runner, ENV, 'conv-1');

    const [started, revived, plain, plainRevived, flipped] = await Promise.all(
      [0, 1, 2, 3, 4].map(async n => await argvOf(folder, n)),
    );
    for (const argv of [started, revived]) {
      const at = argv?.indexOf('service_tier="priority"') ?? -1;
      should(at).be.greaterThan(0);
      should(argv?.[at - 1]).equal('-c');
    }
    should(revived?.slice(0, 2)).eql(['resume', 'conv-1']);
    should(plain?.some(word => word.startsWith('service_tier'))).be.false();
    should(plainRevived?.some(word => word.startsWith('service_tier'))).be.false();
    should(flipped?.filter(word => word.startsWith('service_tier'))).eql(['service_tier="default"']);
  });
});
