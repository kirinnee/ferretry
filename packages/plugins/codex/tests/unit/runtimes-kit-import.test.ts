import { describe, expect, it } from 'bun:test';
import type { KitHarvestInput, KitHostLogin, KitHostScanInput } from '@ferretry/plugin-runtimes/contract';
import { codexImportKit } from '../../daemon/lib/runtimes-kit/import.ts';

const world = (configuredHome?: string) => {
  const reads: string[][] = [];
  const skills: string[][] = [];
  let userMcp = 0;
  const input: KitHostScanInput = {
    userHome: '/fixture/home',
    configuredHome,
    read: async (home, path) => {
      reads.push([home, path]);
      return { kind: 'absent', source: path };
    },
    readUserMcp: async () => {
      userMcp += 1;
      return { kind: 'absent', source: '/fixture/home/.claude.json' };
    },
    skills: async (home, directory) => {
      skills.push([home, directory]);
      return {
        found: [{ item: 'review', source: `${directory}/review`, digest: 'fixture' }],
        problems: ['skill problem'],
      };
    },
    login: async () => ({ state: 'unknown', reason: 'fixture status' }),
    projectInstructions: async () => [],
  };
  return { input, reads, skills, userMcp: () => userMcp };
};

describe('Codex host scan kit', () => {
  it('reads its default home: instructions, config.toml, hooks.json and skills, and never Claude documents', async () => {
    const w = world();
    const scan = await codexImportKit.scanHost!(w.input);
    expect(w.reads).toEqual([
      ['/fixture/home/.codex', '/fixture/home/.codex/AGENTS.md'],
      ['/fixture/home/.codex', '/fixture/home/.codex/config.toml'],
      ['/fixture/home/.codex', '/fixture/home/.codex/hooks.json'],
    ]);
    expect(w.skills).toEqual([['/fixture/home/.codex', '/fixture/home/.codex/skills']]);
    expect(w.userMcp()).toBe(0);
    expect(scan.hooks).toEqual({ kind: 'absent', source: '/fixture/home/.codex/hooks.json' });
    expect(scan.mcp).toBeUndefined();
    expect(scan.projectInstructions).toBeUndefined();
    expect(scan.login).toEqual({ state: 'unknown', reason: 'fixture status' });
    expect(scan.problems).toEqual(['skill problem']);
    expect(scan.skills[0]?.item).toBe('review');
  });

  it('reads an absolute configured home after trimming, and an empty one as the default', async () => {
    const custom = world(' /fixture/custom ');
    await codexImportKit.scanHost!(custom.input);
    expect(custom.reads[0]).toEqual(['/fixture/custom', '/fixture/custom/AGENTS.md']);
    const blank = world('   ');
    await codexImportKit.scanHost!(blank.input);
    expect(blank.reads[0]).toEqual(['/fixture/home/.codex', '/fixture/home/.codex/AGENTS.md']);
  });

  it('reads nothing for a relative CODEX_HOME and says why, as before', async () => {
    const w = world(' relative/home ');
    const scan = await codexImportKit.scanHost!(w.input);
    const reason = 'CODEX_HOME is set to a relative path, so your Codex setup could not be found';
    expect(w.reads).toEqual([]);
    expect(w.skills).toEqual([]);
    expect(scan).toEqual({
      login: { state: 'not-shareable', reason },
      instructions: { kind: 'unreadable', source: ' relative/home ', reason },
      settings: { kind: 'unreadable', source: ' relative/home ', reason },
      hooks: { kind: 'absent', source: ' relative/home ' },
      skills: [],
      problems: [],
    });
  });
});

describe('Codex host harvest kit', () => {
  const imported = { env: { FIXTURE: 'x' }, secretKeys: [], dropped: [], gated: [], plain: [], minted: [] };
  const harvestWorld = (
    rest: Record<string, unknown>,
    options: { skippedEnv?: boolean; hooks?: KitHarvestInput['hooks'] } = {},
  ) => {
    const calls: unknown[][] = [];
    const input: KitHarvestInput = {
      rest,
      source: '/fixture/config.toml',
      mcpSource: '/ignored/.claude.json',
      skippedEnv: options.skippedEnv ?? false,
      skippedModelSet: false,
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      countHooks: block => {
        calls.push(['hooks', block]);
        return 3;
      },
      importEnvironment: (...args) => {
        calls.push(['env', ...args]);
        return imported;
      },
    };
    return { input, calls };
  };

  it('names its own import documents', () => {
    expect(codexImportKit.importSetup).toEqual({
      settingsFormat: 'toml',
      settingsFile: 'config.toml',
      instructionsName: 'AGENTS.md',
    });
  });

  it('drops MCP servers and plumbing keys, delegates the shell environment and keeps the other policy keys', () => {
    const set = { FIXTURE: 'x' };
    const rest: Record<string, unknown> = {
      model: 'fixture-model',
      mcp_servers: { notes: {} },
      cli_auth_credentials_store: 'file',
      sqlite_home: '/fixture/sqlite',
      shell_environment_policy: { inherit: 'core', set },
    };
    const w = harvestWorld(rest);
    const result = codexImportKit.harvest!(w.input);
    expect(rest).toEqual({ model: 'fixture-model', shell_environment_policy: { inherit: 'core' } });
    expect(w.calls).toEqual([['env', set, 'shell_environment_policy.set.', 'config.toml']]);
    expect(result.envImport).toBe(imported);
    expect(result.modelEnvironment).toBeUndefined();
    expect(result.hooks).toBeUndefined();
    expect(result.mcpSource).toBe('/fixture/config.toml');
  });

  it('names its MCP document: the mcp_servers table of config.toml, a disabled server left out', () => {
    expect(codexImportKit.mcpImport).toEqual({
      document: 'settings',
      format: 'toml',
      file: 'config.toml',
      table: 'mcp_servers',
      knownKeys: ['command', 'args', 'env', 'url', 'enabled'],
      skipDisabled: true,
    });
  });

  it("reads each profile's name and only its model and effort as hints, before it drops anything", () => {
    const rest: Record<string, unknown> = {
      profiles: {
        deep: { model: 'fixture-model', model_reasoning_effort: 'high', approval_policy: 'never' },
        modelOnly: { model: 'other-model' },
        effortOnly: { model_reasoning_effort: 'low' },
        blankKeys: { model: '', model_reasoning_effort: '' },
        notATable: 'text',
        '': { model: 'unnamed' },
      },
    };
    const result = codexImportKit.harvest!(harvestWorld(rest).input);
    expect(result.profileHints).toEqual([
      { name: 'deep', model: 'fixture-model', effort: 'high' },
      { name: 'modelOnly', model: 'other-model' },
      { name: 'effortOnly', effort: 'low' },
      { name: 'blankKeys' },
    ]);
  });

  it('has no profile hints when the document declares no profiles table', () => {
    expect(codexImportKit.harvest!(harvestWorld({}).input).profileHints).toEqual([]);
    expect(codexImportKit.harvest!(harvestWorld({ profiles: ['a'] }).input).profileHints).toEqual([]);
  });

  it('removes a policy that held only the environment, and imports nothing when the person skipped env', () => {
    const rest: Record<string, unknown> = { shell_environment_policy: { set: { FIXTURE: 'x' } } };
    const w = harvestWorld(rest, { skippedEnv: true });
    const result = codexImportKit.harvest!(w.input);
    expect(rest).toEqual({});
    expect(w.calls).toEqual([]);
    expect(result.envImport).toBeUndefined();
  });

  it('leaves a policy without a settable environment alone', () => {
    const rest: Record<string, unknown> = { shell_environment_policy: { inherit: 'all' } };
    const w = harvestWorld(rest);
    expect(codexImportKit.harvest!(w.input).envImport).toBeUndefined();
    expect(rest).toEqual({ shell_environment_policy: { inherit: 'all' } });
    expect(w.calls).toEqual([]);
  });

  it('counts the hooks block of a hooks document, or the whole document when it has none, and ignores an empty one', () => {
    const block = { Stop: [{ hooks: [{ command: 'never executed' }] }] };
    const nested = harvestWorld({}, { hooks: { source: '/fixture/hooks.json', document: { hooks: block } } });
    expect(codexImportKit.harvest!(nested.input).hooks).toEqual({ source: '/fixture/hooks.json', count: 3 });
    expect(nested.calls).toEqual([['hooks', block]]);
    const flat = harvestWorld({}, { hooks: { source: '/fixture/hooks.json', document: block } });
    expect(codexImportKit.harvest!(flat.input).hooks).toEqual({ source: '/fixture/hooks.json', count: 3 });
    expect(flat.calls).toEqual([['hooks', block]]);
    const empty = harvestWorld({}, { hooks: { source: '/fixture/hooks.json', document: {} } });
    expect(codexImportKit.harvest!(empty.input).hooks).toBeUndefined();
    expect(empty.calls).toEqual([]);
  });
});

describe('Codex host login notes', () => {
  const notes: readonly [KitHostLogin, string][] = [
    [
      { state: 'signed-in', email: 'fixture@example.invalid' },
      'Login · fixture@example.invalid. Ferretry and your own `codex` share this login: signing out in one signs out both.',
    ],
    [{ state: 'refresh-due' }, 'Login · your login · Refresh due. Ferretry renews it the first time you launch.'],
    [
      { state: 'not-signed-in' },
      "Codex isn't signed in on this machine. Your setup was still imported; sign in later and every runtime on this login can launch.",
    ],
    [
      { state: 'unknown' },
      'Codex sign-in is unknown (Logins has no host discovery fact). Your login stays shared in place.',
    ],
    [
      { state: 'unreadable', reason: 'fixture read refused' },
      "Ferretry couldn't read your Codex login (fixture read refused). It is still shared in place; check it on the Sign-ins tab.",
    ],
    [
      { state: 'not-shareable' },
      "Your Codex login can't be shared in place (it is not kept in a file), so this login needs its own sign-in.",
    ],
  ];

  for (const [login, note] of notes) {
    it(`keeps the ${login.state} message`, () => {
      expect(codexImportKit.loginNote!(login)).toBe(note);
    });
  }
});
