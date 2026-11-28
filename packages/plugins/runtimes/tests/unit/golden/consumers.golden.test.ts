/**
 * E-276 0a: the DATA-WORD CONSUMERS — places Runtimes reads the harness word as data and answers differently for Claude and
 * Codex without ever calling a harness function: which runtime is the default (Claude's before Codex's), where each harness's
 * settings file lives and in what format it is read and written, the built-in profiles' comfort settings, the words an owner
 * hand-over uses for each tool, and the commands the host is asked about (and the fallback folders asked only for the two
 * harness commands). Every one is a plain table today; a move that turns a table into per-plugin code has to answer the same.
 *
 * Fake ports only: Logins' views are literals, the owners' writer is a function, the kernel's command lookup records its calls.
 */
import { describe, it } from 'bun:test';
import { claudeRuntimesKit } from '../../../../claude-code/daemon/lib/runtimes-kit/index.ts';
import { codexRuntimesKit } from '../../../../codex/daemon/lib/runtimes-kit/index.ts';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import type { ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { fileFleetSetupDeps } from '../../../daemon/adapters/setup-files.ts';
import { fileAssembly } from '../../../daemon/host-assembly.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { unavailableCatalogDeps } from '../../../daemon/lib/service/assembly.ts';
import { FleetCatalogService, type FleetCatalogServiceDeps } from '../../../daemon/lib/service/catalog-service.ts';
import { HOST_HOME, HOSTS, memoryHostFiles } from './support/host-world.ts';
import { harnessAwareWhich } from '../../../daemon/adapters/harness-lookup.ts';
import { CommandCache } from '../../../daemon/adapters/command-cache.ts';
import { toolInstaller } from '../../../daemon/adapters/tool-installer.ts';
import {
  BUILTIN_COMPONENTS,
  builtinDocument,
  builtinProfileLayers,
  starterModelSet,
} from '../../../daemon/lib/account/builtin-autonomous.ts';
import {
  type ComponentWriter,
  type OwnerWriteOutcome,
  ownerWrites,
} from '../../../daemon/lib/account/owner-components.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { handOver, type OwnedComponents } from '../../../daemon/lib/service/owner-hand-over.ts';
import { type AccountChangeFacts, deriveAccountChange } from '../../../daemon/lib/service/mutations.ts';
import { createRuntimesApi } from '../../../daemon/lib/service/runtimes-api.ts';
import { expectGolden } from './support/golden.ts';

// ── runtimes-api: the default runtime's harness preference ──────────────────────────────────────

const loginView = (id: string, harness: 'claude-code' | 'codex', word = 'ready') =>
  ({ id, harness, harnesses: [harness], status: { word } }) as unknown as LoginView;

const apiOver = (logins: readonly LoginView[], runtimes: Record<string, RuntimeFile> = {}, defaultSetting?: string) =>
  createRuntimesApi({
    runtimes: () => new Map(Object.entries(runtimes)),
    profiles: () => new Map<string, ProfileFile>(),
    defaultSetting: () => defaultSetting,
    harnesses: () => ['claude-code', 'codex'],
    logins: {
      environmentTemplates: async () => [],
      list: async () => ({ logins }) as never,
    },
    now: () => Date.parse('2026-11-08T12:00:00Z'),
  });

/** The real kits of the two shipped harnesses, in setup only (the settings format each reads is its plugin's). */
const GOLDEN_KITS = new Map([
  ['claude', claudeRuntimesKit],
  ['codex', codexRuntimesKit],
] as const);

describe('data-word consumer goldens', () => {
  it('should prefer a Claude runtime that can launch over a Codex one, and a Codex one over nothing, exactly as the base does', async () => {
    const scenarios: Record<string, readonly LoginView[]> = {
      'codex listed first, claude second': [loginView('aaa-codex', 'codex'), loginView('zzz-claude', 'claude-code')],
      'claude listed first, codex second': [loginView('aaa-claude', 'claude-code'), loginView('zzz-codex', 'codex')],
      'only codex': [loginView('only-codex', 'codex')],
      'claude needs sign-in, codex ready': [
        loginView('aaa-claude', 'claude-code', 'needs_sign_in'),
        loginView('zzz-codex', 'codex'),
      ],
      'both need sign-in': [
        loginView('aaa-claude', 'claude-code', 'needs_sign_in'),
        loginView('zzz-codex', 'codex', 'needs_sign_in'),
      ],
      'no logins': [],
    };
    const answers: Record<string, unknown> = {};
    for (const [name, logins] of Object.entries(scenarios)) {
      const api = apiOver(logins);
      answers[name] = {
        default: (await api.default()) ?? null,
        list: (await api.list()).map(summary => ({
          id: summary.id,
          harness: summary.harness,
          available: summary.launch.available,
        })),
      };
    }
    const named = apiOver([loginView('aaa-codex', 'codex'), loginView('zzz-claude', 'claude-code')], {}, 'aaa-codex');
    answers['a named default beats the order'] = { default: (await named.default()) ?? null };
    expectGolden('consumers/default-runtime', answers);
  });

  // ── mutations: the settings file each harness writes and reads ────────────────────────────────

  it('should write and read each harness settings file in its own format exactly as the base does', () => {
    const model = parseAccountModel({
      version: 1,
      credentials: {
        'claude-a': { harness: 'claude', store: 'ferretry' },
        'codex-a': { harness: 'codex', store: 'ferretry' },
      },
      components: {
        settings: {
          'cl-settings': { harness: 'claude', file: 'components/settings/cl-settings.json' },
          'cx-settings': { harness: 'codex', file: 'components/settings/cx-settings.toml' },
        },
      },
      profiles: { plain: { layers: ['settings/cl-settings'] } },
      runtimes: {},
    });
    const facts: AccountChangeFacts = {
      machineName: 'box',
      runningSessions: 0,
      kits: GOLDEN_KITS,
      settingsBodies: {
        'cl-settings': { permissions: { keepMe: 'yes' } },
        'cx-settings': { shell_environment_policy: { keepMe: 'yes' } },
      },
    };
    const derive = (component: object, over: object = {}) => {
      try {
        const edit = deriveAccountChange(
          model,
          { kind: 'component.put', name: 'fresh', create: true, component, ...over } as never,
          facts,
        );
        return {
          summary: edit.summary,
          files: edit.files,
          component: edit.model.components.settings.fresh ?? null,
          consequences: edit.consequences,
        };
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) };
      }
    };
    const entries = {
      'permissions.defaultMode': { value: 'plan' },
      model: { value: 'golden' },
      'a.keep': { keep: true },
    };
    expectGolden('consumers/settings-files', {
      claudeJson: derive({ kind: 'settings', harness: 'claude-code' }, { content: '{"theme":"dark"}' }),
      codexToml: derive({ kind: 'settings', harness: 'codex' }, { content: 'model = "gpt-6"\n' }),
      claudeJsonThatIsToml: derive({ kind: 'settings', harness: 'claude-code' }, { content: 'model = "gpt-6"\n' }),
      codexTomlThatIsJson: derive({ kind: 'settings', harness: 'codex' }, { content: '{"theme":"dark"}' }),
      claudeEntries: derive(
        { kind: 'settings', harness: 'claude-code', entries },
        { name: 'cl-settings', create: false },
      ),
      codexEntries: derive({ kind: 'settings', harness: 'codex', entries }, { name: 'cx-settings', create: false }),
      claudeFlagsAndEnv: derive({ kind: 'settings', harness: 'claude-code', flags: ['--fast'], env: { MODE: 'x' } }),
      codexFlagsAndEnv: derive({ kind: 'settings', harness: 'codex', flags: ['--search'], env: { MODE: 'x' } }),
      claudeInstructions: derive({ kind: 'instructions', harness: 'claude-code' }, { content: '# notes' }),
      codexInstructions: derive({ kind: 'instructions', harness: 'codex' }, { content: '# notes' }),
      claudeHooks: derive({ kind: 'hooks', harness: 'claude-code' }, { content: '{"hooks":{}}' }),
      thirdHarness: derive({ kind: 'settings', harness: 'opencode' }, { content: '{}' }),
      wireKeyClaude: derive({ kind: 'settings', harness: 'claude' }, { content: '{}' }),
    });
  });

  // ── owner hand-over: the file each tool's component lands in, and the words that name it ──────

  it('should hand each owner its component and name each tool in words exactly as the base does', async () => {
    const before = parseAccountModel({ version: 1 });
    const next = parseAccountModel({
      version: 1,
      components: {
        mcp: {
          'claude-files': { command: 'npx', args: ['files'] },
          'codex-files': { command: 'npx', args: ['files'] },
          shared: { url: 'https://docs.example.test/mcp' },
        },
        skills: { 'claude-skills': { items: ['review'] }, 'codex-skills': { items: ['deploy'] } },
        settings: {
          'claude-settings': { harness: 'claude', file: 'settings/claude-settings.json' },
          'codex-settings': { harness: 'codex', file: 'settings/codex-settings.toml' },
          'codex-broken': { harness: 'codex', file: 'settings/broken.toml' },
          'claude-inline': { harness: 'claude', document: { verbose: true }, env: { MODE: 'x' } },
        },
      },
    });
    const assets: Record<string, string> = {
      'settings/claude-settings.json': '{"theme":"dark","env":{"EDITOR":"vim"}}',
      'settings/codex-settings.toml': 'model = "gpt-6"\n[shell_environment_policy]\ninherit = "core"\n',
    };
    const files: Record<string, { path: string; content: string }[]> = {
      'skills/review/': [
        { path: 'skills/review/SKILL.md', content: '---\nname: review\n---\n' },
        { path: 'skills/review/.hidden', content: 'x' },
      ],
      'skills/deploy/': [{ path: 'skills/deploy/SKILL.md', content: '---\nname: deploy\n---\n' }],
    };
    const writes = ownerWrites(
      before,
      next,
      file => assets[file],
      prefix => files[prefix] ?? [],
      [],
      () => [],
      () => ({}),
      GOLDEN_KITS,
    );
    const answers: Record<string, OwnerWriteOutcome> = {
      'mcp/claude-files': { outcome: 'written' },
      'mcp/codex-files': { outcome: 'held' },
      'mcp/shared': { outcome: 'refused', reason: 'the owner is switched off' },
      'skills/claude-skills': { outcome: 'written', warnings: ['one file was large'] },
      'skills/codex-skills': { outcome: 'written' },
      'settings/claude-settings': { outcome: 'written' },
      'settings/codex-settings': { outcome: 'held' },
    };
    const writer: ComponentWriter = {
      put: async write => answers[write.reference] ?? { outcome: 'refused', reason: 'no answer' },
    };
    const owners: OwnedComponents = {
      writes,
      rebuild: async () => ({ model: next, documents: [] }),
    };
    const result = await handOver({
      writer,
      owners,
      applied: { model: next, documents: [] },
      secretValues: [],
      inEffect: async () => next,
    });
    expectGolden('consumers/owner-hand-over', {
      writes,
      landed: result.landed,
      held: result.held,
      refused: result.refused,
      sentences: result.sentences,
    });
  });

  // ── the built-in profiles ─────────────────────────────────────────────────────────────────────

  it('should hold the built-in profiles exactly as the base does: Claude has comfort settings, Codex has none', () => {
    const starters = { claude: 'claude-opus-5-5', codex: 'gpt-6' } as const;
    expectGolden('consumers/builtin-profiles', {
      layers: {
        claudeWithStarter: builtinProfileLayers('claude', starters),
        claudeWithout: builtinProfileLayers('claude', {}),
        codexWithStarter: builtinProfileLayers('codex', starters),
        codexWithout: builtinProfileLayers('codex', {}),
        claudeNamedModelSet: builtinProfileLayers('claude', starters, 'pinned'),
      },
      starterModelSets: {
        claude: starterModelSet('claude', starters) ?? null,
        codex: starterModelSet('codex', starters) ?? null,
        codexNone: starterModelSet('codex', {}) ?? null,
      },
      components: {
        instructions: Object.keys(BUILTIN_COMPONENTS.instructions),
        settings: BUILTIN_COMPONENTS.settings,
      },
      document: builtinDocument(starters),
    });
  });

  // ── the host's command lookup ─────────────────────────────────────────────────────────────────

  it('should look the harness commands up exactly as the base does: the PATH first, and the install folders for the two harnesses only', async () => {
    const answers: Record<string, unknown> = {};
    for (const scenario of ['everything on PATH', 'harnesses only in the install folders', 'nothing found'] as const) {
      const calls: string[] = [];
      const which = async (name: string, options?: { readonly directories?: readonly string[] }) => {
        calls.push(`${name}${options?.directories === undefined ? '' : ` in ${options.directories.join(':')}`}`);
        if (scenario === 'everything on PATH') return `/usr/bin/${name}`;
        if (scenario === 'harnesses only in the install folders')
          return options?.directories !== undefined && (name === 'claude' || name === 'codex')
            ? `/install/${name}`
            : undefined;
        return undefined;
      };
      const platform = { name: () => 'linux', prime: async () => undefined };
      const lookup = harnessAwareWhich({ which, home: () => '/home/person', platform });
      const found: Record<string, string | null> = {};
      for (const name of ['claude', 'codex', 'npm', 'brew', 'apt-get', 'some-mcp-server'])
        found[name] = (await lookup(name)) ?? null;
      answers[scenario] = { found, calls };
    }
    expectGolden('consumers/command-lookup', answers);
  });

  it('should plan and check an install exactly as the base does: the same commands are looked up afresh, for both harnesses', async () => {
    const answers: Record<string, unknown> = {};
    const owner = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' as const }) } as never;
    // `installedAfter`: what the manager "installs" (the lookup answers it only once the manager has run).
    const scenarios: Record<
      string,
      { readonly present: readonly string[]; readonly platform: string; readonly installedAfter?: readonly string[] }
    > = {
      'nothing installed on linux with npm': {
        present: ['npm'],
        platform: 'linux',
        installedAfter: ['claude', 'codex'],
      },
      'nothing installed on macOS with brew and npm': {
        present: ['npm', 'brew'],
        platform: 'darwin',
        installedAfter: ['claude', 'codex'],
      },
      'claude installed, codex absent, only npm': {
        present: ['claude', 'npm'],
        platform: 'linux',
        installedAfter: ['codex'],
      },
      'both installed': { present: ['claude', 'codex'], platform: 'linux' },
      'no manager at all': { present: [], platform: 'linux' },
    };
    for (const [name, scenario] of Object.entries(scenarios)) {
      const looked: string[] = [];
      const ran: string[] = [];
      let managerRan = false;
      const cache = new CommandCache(
        {
          which: async command => {
            looked.push(command);
            return scenario.present.includes(command) ||
              (managerRan && scenario.installedAfter?.includes(command) === true)
              ? `/bin/${command}`
              : undefined;
          },
        },
        () => 0,
      );
      let primed = 0;
      const installer = toolInstaller({
        commands: cache,
        kits: () =>
          new Map([
            ['claude', claudeRuntimesKit],
            ['codex', codexRuntimesKit],
          ] as const),
        platform: { name: () => scenario.platform, prime: async () => void primed++ },
        spawn: () =>
          ({
            start: (command: string, args: readonly string[]) => {
              ran.push([command, ...args].join(' '));
              managerRan = true;
              const empty = () => new ReadableStream<Uint8Array>({ start: controller => controller.close() });
              return {
                pid: 1,
                stdout: empty(),
                stderr: empty(),
                write: () => undefined,
                kill: () => undefined,
                exited: Promise.resolve(0),
                pipes: [],
                closePipes: () => undefined,
              };
            },
          }) as never,
        clock: { after: () => () => undefined, nowMs: () => 0 } as never,
      });
      await cache.prime(['claude', 'codex', 'npm', 'brew', 'apt-get']);
      const plans = installer.plans(['claude', 'codex']);
      looked.length = 0;
      const outcome = await installer.install({ harnesses: ['claude', 'codex'] }, owner).then(
        done => done,
        (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
      );
      answers[name] = { plans, lookedUpAtInstall: looked, ran, primed, outcome };
    }
    expectGolden('consumers/tool-installer', answers);
  });

  it('should ask the kernel about exactly these commands before every read of what is installed, exactly as the base does', async () => {
    const answers: Record<string, unknown> = {};
    for (const found of [['claude', 'codex'], ['claude'], []] as const) {
      const asked: string[] = [];
      // A kernel that is only a recording `paths.which` and a `fleet` root that resolves a path: no disk, no process.
      const rootStub = new Proxy(
        {
          resolve: (path: string) => ({ ok: true, value: path === '.' ? '/fy/fleet' : `/fy/fleet/${path}` }),
        } as Record<string, unknown>,
        { get: (target, key) => (key in target ? target[key as string] : () => undefined) },
      );
      const kernel = {
        roots: { root: () => rootStub },
        paths: {
          home: () => '/home/person',
          which: async (name: string, options?: { readonly directories?: readonly string[] }) => {
            asked.push(options?.directories === undefined ? name : `${name} (install folders)`);
            return found.includes(name as never) ? `/bin/${name}` : undefined;
          },
        },
        clock: { nowMs: () => 0, after: () => () => undefined },
        log: { warn: () => undefined },
        identity: { daemonId: undefined },
        state: {},
        config: {},
      } as never;
      const needs = {
        logins: { list: async () => ({ logins: [] }) },
        loginChanges: {},
        ferrets: { list: async () => [] },
      } as never;
      const assembly = fileAssembly(
        { kernel, needs, hooks: { provider: () => 'unavailable' } } as never,
        new FleetPublication(),
      );
      await assembly.primeInstalled();
      answers[`on this machine: ${found.join(', ') || 'nothing'}`] = { asked, installed: assembly.installed() };
    }
    expectGolden('consumers/host-assembly-lookups', answers);
  });

  it('should resolve the commands a host scan asks about exactly as the base does: the harnesses through the catalogue, every other through the PATH cache', async () => {
    const asked: string[] = [];
    const deps = fileFleetSetupDeps({
      host: {
        files: memoryHostFiles(HOSTS.both as never),
        texts: { read: async () => null, write: async () => undefined },
        commands: {
          which: (name: string) => {
            asked.push(`PATH ${name}`);
            return name === 'npx' ? '/bin/npx' : undefined;
          },
        },
        disk: {},
        now: () => 0,
        claimFor: () => ({ acquire: async () => 'token', release: async () => undefined, path: '/fy/fleet/.lock' }),
      } as never,
      catalog: {
        kits: () =>
          new Map([
            ['claude', claudeRuntimesKit],
            ['codex', codexRuntimesKit],
          ] as const),
        layout: {
          stateHome: '/fy',
          userHome: HOST_HOME,
          fleetDirectory: '/fy/fleet',
          binDirectory: '/fy/fleet/bin',
          homesDirectory: '/fy/fleet/homes',
          assetsDirectory: '/fy/fleet/assets',
          manifestPath: '/fy/fleet/manifest.json',
          defaultHomeDirectories: [`${HOST_HOME}/.claude`, `${HOST_HOME}/.codex`],
        },
        locate: (harness: string) => {
          asked.push(`catalogue ${harness}`);
          return harness === 'claude' ? '/opt/harness/bin/claude' : undefined;
        },
      } as never,
      logins: fakeLogins([]),
      tools: {} as never,
      daemonId: () => undefined,
      secrets: { list: async () => [], put: async () => undefined },
    });
    const scans = await deps.scan();
    expectGolden('consumers/host-scan-commands', {
      asked,
      harnesses: scans.map(scan => ({
        harness: scan.harness,
        command: scan.command ?? null,
        missingCommands: scan.missingCommands,
      })),
    });
  });

  it('should read each harness settings file in its own format when the catalogue resolves a profile, exactly as the base does', async () => {
    const model = parseAccountModel({
      version: 1,
      credentials: {
        'claude-you': { harness: 'claude', store: 'host' },
        'codex-you': { harness: 'codex', store: 'host' },
      },
      components: {
        settings: {
          'cl-settings': {
            harness: 'claude',
            file: 'components/settings/cl-settings.json',
            env: { MODE: 'x' },
            flags: ['--verbose'],
          },
          'cx-settings': { harness: 'codex', file: 'components/settings/cx-settings.toml' },
          'cl-bad': { harness: 'claude', file: 'components/settings/cl-bad.json' },
          'cx-bad': { harness: 'codex', file: 'components/settings/cx-bad.toml' },
          'cl-wrong': { harness: 'claude', file: 'components/settings/cl-wrong.json' },
          'cx-wrong': { harness: 'codex', file: 'components/settings/cx-wrong.toml' },
        },
      },
      profiles: { default: { layers: ['settings/cl-settings'] } },
      runtimes: {},
    });
    const assets: Record<string, string> = {
      'components/settings/cl-settings.json': '{"theme":"dark","permissions":{"allow":["Bash(ls)"]}}',
      'components/settings/cx-settings.toml': 'model = "gpt-6"\n[shell_environment_policy]\ninherit = "core"\n',
      'components/settings/cl-bad.json': '{ not json',
      'components/settings/cx-bad.toml': 'a = = 1',
      // A file in the OTHER harness's format: each harness is read in its own, so each of these is not a document.
      'components/settings/cl-wrong.json': 'model = "gpt-6"\n',
      'components/settings/cx-wrong.toml': '{"theme":"dark"}',
    };
    const base = unavailableCatalogDeps(
      () => 1_794_052_800_000,
      fakeLogins([sampleLogin('claude-you')]),
      fakeLoginChanges(),
    );
    const deps: FleetCatalogServiceDeps = {
      ...base,
      document: async () =>
        ({
          format: 'present',
          model,
          revision: 'rev-1',
          unreadable: [],
          stoodInLogins: [],
          documents: () => [],
        }) as never,
      readAsset: async (path: string) => assets[path.replace('/fy/fleet/assets/', '')],
      documentRevision: async () => 'absent',
      ids: async () => undefined,
      locate: () => '/usr/bin/harness',
      layout: {
        stateHome: '/fy',
        userHome: '/home/person',
        fleetDirectory: '/fy/fleet',
        binDirectory: '/fy/fleet/bin',
        homesDirectory: '/fy/fleet/homes',
        assetsDirectory: '/fy/fleet/assets',
        manifestPath: '/fy/fleet/manifest.json',
        defaultHomeDirectories: ['/home/person/.claude', '/home/person/.codex'],
      },
      kits: () => GOLDEN_KITS,
      claudeStatusline: () => "'fy' statusline",
      fyCommand: '/opt/ferretry/bin/fy',
    } as never;
    const service = new FleetCatalogService(deps);
    const drafts: Record<string, unknown> = {};
    for (const layers of [
      ['settings/cl-settings'],
      ['settings/cx-settings'],
      ['settings/cl-bad'],
      ['settings/cx-bad'],
      ['settings/cl-wrong'],
      ['settings/cx-wrong'],
    ]) {
      try {
        drafts[layers.join(',')] = await service.previewProfile({ layers });
      } catch (error) {
        drafts[layers.join(',')] = { refused: error instanceof Error ? error.message : String(error) };
      }
    }
    expectGolden('consumers/catalogue-settings', { drafts, components: await service.components() });
  });
});
