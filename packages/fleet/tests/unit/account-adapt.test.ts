import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AdaptedRuntime,
  type AdaptInput,
  type AdaptPlumbing,
  adaptProfile,
  CODEX_IGNORED_SKILL_KEYS,
  type ComponentBodies,
  componentPartialSupport,
  concatenateInstructions,
  describePartialSupport,
  isSseUrl,
  partialSupportBadge,
  SKILLS_STORE_DIRECTORY,
  skillFrontmatterKeys,
  skillSourceReference,
  usesClaudeImports,
} from '../../src/lib/account/adapt.ts';
import { type ResolvedProfile, resolveProfile } from '../../src/lib/account/layering.ts';
import { type AccountModelDocument, parseAccountModel } from '../../src/lib/account/schema.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import type { SettingsObject } from '../../src/lib/settings.ts';

type Components = NonNullable<AccountModelDocument['components']>;

const SQLITE_HOME = '/fy/fleet/shared/codex/sqlite';

/** The statusLine the tests bind, recording the person's own command it was handed. */
const statusLine = (own?: string): string => (own === undefined ? 'fy statusline' : `fy statusline --then '${own}'`);

const plumbingFor = (harness: HarnessKind): AdaptPlumbing =>
  harness === 'claude' ? { harness, statusLine } : { harness, sqliteHome: SQLITE_HOME };

/** One profile `p` holding `layers`, over `components`, resolved for `harness`. */
const resolve = (
  harness: HarnessKind,
  components: Components,
  layers: string[],
  settingsBodies?: Record<string, SettingsObject>,
): ResolvedProfile => {
  const model = parseAccountModel({ version: 2, components, profiles: { p: { layers } } });
  const result = resolveProfile({ model, profile: 'p', harness, ...(settingsBodies ? { settingsBodies } : {}) });
  if (!result.ok) throw new Error('unexpected');
  return result.resolved;
};

const adapt = (
  harness: HarnessKind,
  components: Components,
  layers: string[],
  options: { bodies?: ComponentBodies; settingsBodies?: Record<string, SettingsObject> } & Partial<AdaptInput> = {},
): AdaptedRuntime =>
  adaptProfile({
    resolved: resolve(harness, components, layers, options.settingsBodies),
    plumbing: options.plumbing ?? plumbingFor(harness),
    ...(options.bodies ? { bodies: options.bodies } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
  });

describe('adaptProfile — instructions', () => {
  it('should link one instructions component as CLAUDE.md for Claude', () => {
    // Act
    const actual = adapt('claude', { instructions: { main: { file: 'components/instructions/main.md' } } }, [
      'instructions/main',
    ]);

    // Assert
    actual.entries.should.deepEqual([
      { kind: 'link', dest: 'CLAUDE.md', source: 'components/instructions/main.md', from: ['instructions/main'] },
    ]);
    actual.absent.should.not.containEql('CLAUDE.md');
    actual.problems.should.deepEqual([]);
  });

  it('should link the same component as AGENTS.md for Codex', () => {
    // Act
    const actual = adapt('codex', { instructions: { main: { file: 'main.md' } } }, ['instructions/main']);

    // Assert
    actual.entries.should.deepEqual([
      { kind: 'link', dest: 'AGENTS.md', source: 'main.md', from: ['instructions/main'] },
    ]);
  });

  it('should copy an instructions file that lives outside the asset tree', () => {
    // Act
    const actual = adapt('claude', { instructions: { mine: { file: '~/notes/CLAUDE.md' } } }, ['instructions/mine']);

    // Assert
    should(actual.entries[0]).have.properties({ kind: 'copy', source: '~/notes/CLAUDE.md' });
  });

  it('should generate one document from several, oldest first', () => {
    // Arrange
    const components = { instructions: { a: { file: 'a.md' }, b: { file: 'b.md' } } };

    // Act
    const actual = adapt('codex', components, ['instructions/a', 'instructions/b'], {
      bodies: { instructions: { a: 'First.\n\n', b: '  Second.' } },
    });

    // Assert
    actual.entries.should.deepEqual([
      {
        kind: 'generated',
        dest: 'AGENTS.md',
        content:
          '<!-- Generated from instructions/a, instructions/b. Edit those components, not this file. -->\n\nFirst.\n\nSecond.\n',
        from: ['instructions/a', 'instructions/b'],
      },
    ]);
  });

  it('should refuse to put several together when one could not be read, naming it', () => {
    // Act
    const actual = adapt(
      'claude',
      { instructions: { a: { file: 'a.md' }, b: { file: 'b.md' } } },
      ['instructions/a', 'instructions/b'],
      { bodies: { instructions: { a: 'First.' } } },
    );

    // Assert
    actual.entries.should.deepEqual([]);
    actual.absent.should.not.containEql('CLAUDE.md');
    actual.problems.should.deepEqual([
      {
        kind: 'unread',
        reference: 'instructions/b',
        message: 'instructions "b" could not be read, so CLAUDE.md cannot be put together',
      },
    ]);
  });

  it('should mark the instructions file absent when the profile has none', () => {
    // Act
    const actual = adapt('codex', { modelSets: { m: { models: ['gpt-6'], default: 'gpt-6' } } }, ['modelSets/m']);

    // Assert
    actual.absent.should.containEql('AGENTS.md');
  });
});

describe('adaptProfile — skills', () => {
  it('should link each item under its own name, from the skills store', () => {
    // Act
    const actual = adapt('codex', { skills: { mine: { items: ['review', 'deploy'] } } }, ['skills/mine']);

    // Assert
    actual.entries.should.deepEqual([
      { kind: 'link', dest: 'skills/review', source: 'skills/review', from: ['skills/mine'] },
      { kind: 'link', dest: 'skills/deploy', source: 'skills/deploy', from: ['skills/mine'] },
    ]);
  });

  it("should name Codex's own skills folder as harness-owned, and Claude's as nothing", () => {
    // Act
    const codex = adapt('codex', { skills: { mine: { items: ['review'] } } }, ['skills/mine']);
    const claude = adapt('claude', { skills: { mine: { items: ['review'] } } }, ['skills/mine']);

    // Assert
    codex.harnessOwned.should.deepEqual(['skills/.system']);
    claude.harnessOwned.should.deepEqual([]);
  });

  it("should refuse a Codex item named after Codex's own skills folder", () => {
    // Act
    const actual = adapt('codex', { skills: { mine: { items: ['.system', 'review'] } } }, ['skills/mine']);

    // Assert
    actual.entries.map(entry => entry.dest).should.deepEqual(['skills/review']);
    actual.problems.should.deepEqual([
      {
        kind: 'reserved-skill-item',
        item: '.system',
        reference: 'skills/mine',
        message:
          'skill ".system" has the name of the folder Codex keeps its own skills in, so it cannot be added: rename it',
      },
    ]);
  });

  it('should allow that name on Claude, which keeps nothing there', () => {
    // Act
    const actual = adapt('claude', { skills: { mine: { items: ['.system'] } } }, ['skills/mine']);

    // Assert
    actual.problems.should.deepEqual([]);
    actual.entries.map(entry => entry.dest).should.deepEqual(['skills/.system']);
  });

  it('should place a skill item in the skills store directory', () => {
    // Assert
    SKILLS_STORE_DIRECTORY.should.equal('skills');
    skillSourceReference('review').should.equal('skills/review');
  });
});

describe('adaptProfile — MCP servers on Claude', () => {
  it('should write each server into .claude.json, forwarding a secret by name', () => {
    // Arrange
    const components = {
      mcp: {
        github: {
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { LEVEL: 'debug', GITHUB_TOKEN: '${secret:GH_TOKEN}' },
        },
      },
    };

    // Act
    const actual = adapt('claude', components, ['mcp/github']);

    // Assert
    should(actual.claudeJson).deepEqual({
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { LEVEL: 'debug', GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        },
      },
    });
    actual.launchEnv.should.deepEqual({ GITHUB_TOKEN: '${secret:GH_TOKEN}' });
    JSON.stringify(actual.settings.value).should.not.containEql('mcpServers');
  });

  it('should reach a url server over HTTP, or SSE when its path says so', () => {
    // Arrange
    const components = {
      mcp: {
        api: { url: 'https://mcp.example.com/mcp' },
        linear: { url: 'https://mcp.linear.app/sse/' },
        plain: { command: 'uvx' },
      },
    };

    // Act
    const actual = adapt('claude', components, ['mcp/api', 'mcp/linear', 'mcp/plain']);

    // Assert
    should(actual.claudeJson).deepEqual({
      mcpServers: {
        api: { type: 'http', url: 'https://mcp.example.com/mcp' },
        linear: { type: 'sse', url: 'https://mcp.linear.app/sse/' },
        plain: { type: 'stdio', command: 'uvx', args: [] },
      },
    });
  });

  it('should always write mcpServers, so a removed server leaves the file', () => {
    // Act
    const actual = adapt('claude', { instructions: { main: { file: 'm.md' } } }, ['instructions/main']);

    // Assert
    should(actual.claudeJson).deepEqual({ mcpServers: {} });
  });
});

describe('adaptProfile — MCP servers on Codex', () => {
  it('should write [mcp_servers.<name>] tables into config.toml, forwarding secrets in env_vars', () => {
    // Arrange
    const components = {
      mcp: {
        github: { command: 'npx', args: ['-y', 'gh'], env: { LEVEL: 'debug', TOKEN: '${secret:GH}' } },
        bare: { command: 'uvx', args: [] },
        api: { url: 'https://mcp.example.com/mcp' },
      },
    };

    // Act
    const actual = adapt('codex', components, ['mcp/github', 'mcp/bare', 'mcp/api']);

    // Assert
    should(actual.settings.value.mcp_servers).deepEqual({
      github: { command: 'npx', args: ['-y', 'gh'], env: { LEVEL: 'debug' }, env_vars: ['TOKEN'] },
      bare: { command: 'uvx' },
      api: { url: 'https://mcp.example.com/mcp' },
    });
    actual.launchEnv.should.deepEqual({ TOKEN: '${secret:GH}' });
    should(actual.claudeJson).be.undefined();
  });

  it('should replace a same-named server a settings file set, and say which layer lost', () => {
    // Arrange
    const components = {
      mcp: { github: { command: 'npx' } },
      settings: { base: { harness: 'codex' as const, file: 'config.toml' } },
    };

    // Act
    const actual = adapt('codex', components, ['settings/base', 'mcp/github'], {
      settingsBodies: { base: { mcp_servers: { github: { command: 'old' }, other: { command: 'keep' } } } },
    });

    // Assert
    should(actual.settings.value.mcp_servers).deepEqual({ github: { command: 'npx' }, other: { command: 'keep' } });
    actual.overrides
      .map(({ key, value, by }) => ({ key, value, by }))
      .should.deepEqual([{ key: 'mcp_servers.github.command', value: 'old', by: 'mcp/github' }]);
  });

  it('should report no override when the settings file already says the same', () => {
    // Act
    const actual = adapt(
      'codex',
      { mcp: { github: { command: 'npx' } }, settings: { base: { harness: 'codex', file: 'c.toml' } } },
      ['settings/base', 'mcp/github'],
      { settingsBodies: { base: { mcp_servers: { github: { command: 'npx' } } } } },
    );

    // Assert
    actual.overrides.should.deepEqual([]);
  });

  it('should report a value above the server it replaces, but not an empty table it fills', () => {
    // Arrange
    const components = {
      mcp: { github: { command: 'npx' } },
      settings: {
        scalar: { harness: 'codex' as const, file: 'a.toml' },
        empty: { harness: 'codex' as const, file: 'b.toml' },
        deeper: { harness: 'codex' as const, file: 'c.toml' },
      },
    };
    const run = (layer: string, body: SettingsObject) =>
      adapt('codex', components, [`settings/${layer}`, 'mcp/github'], { settingsBodies: { [layer]: body } });

    // Act
    const scalar = run('scalar', { mcp_servers: 'none' });
    const empty = run('empty', { mcp_servers: {} });
    const deeper = run('deeper', { mcp_servers: { github: { command: { nested: true } } } });

    // Assert
    scalar.overrides.map(override => override.key).should.deepEqual(['mcp_servers']);
    empty.overrides.should.deepEqual([]);
    deeper.overrides.map(override => override.key).should.deepEqual(['mcp_servers.github.command.nested']);
  });
});

describe('adaptProfile — MCP environment collisions', () => {
  it('should refuse two servers that need one variable from different secrets, once', () => {
    // Arrange
    const components = {
      mcp: {
        a: { command: 'a', env: { TOKEN: '${secret:A}' } },
        b: { command: 'b', env: { TOKEN: '${secret:B}' } },
        c: { command: 'c', env: { TOKEN: '${secret:C}' } },
      },
    };

    // Act
    const actual = adapt('claude', components, ['mcp/a', 'mcp/b', 'mcp/c']);

    // Assert
    actual.problems.should.deepEqual([
      {
        kind: 'mcp-env-collision',
        variable: 'TOKEN',
        references: ['mcp/a', 'mcp/b'],
        message:
          'MCP servers "a" and "b" both need TOKEN from a different secret, but a runtime has one TOKEN: rename it in one of them',
      },
    ]);
    actual.launchEnv.should.deepEqual({ TOKEN: '${secret:A}' });
  });

  it('should share one variable between servers that name the same secret', () => {
    // Act
    const actual = adapt(
      'codex',
      { mcp: { a: { command: 'a', env: { T: '${secret:S}' } }, b: { command: 'b', env: { T: '${secret:S}' } } } },
      ['mcp/a', 'mcp/b'],
    );

    // Assert
    actual.problems.should.deepEqual([]);
    actual.launchEnv.should.deepEqual({ T: '${secret:S}' });
  });
});

describe('adaptProfile — hooks on Claude', () => {
  it("should merge hooks documents into settings.json's hooks block, after the settings' own", () => {
    // Arrange
    const components = {
      settings: { base: { harness: 'claude' as const, file: 's.json' } },
      hooks: {
        fmt: { harness: 'claude' as const, file: 'fmt.json' },
        lint: { harness: 'claude' as const, file: 'lint.json' },
      },
    };
    const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'own' }] };
    const fmt = { matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] };
    const lint = { matcher: 'Write', hooks: [{ type: 'command', command: 'lint' }] };

    // Act
    const actual = adapt('claude', components, ['settings/base', 'hooks/fmt', 'hooks/lint'], {
      settingsBodies: { base: { hooks: { PostToolUse: [own], Stop: 'not a list' } } },
      bodies: { hooks: { fmt: { PostToolUse: [fmt] }, lint: { hooks: { PostToolUse: [lint], Stop: [lint] } } } },
    });

    // Assert
    should(actual.settings.value.hooks).deepEqual({ PostToolUse: [own, fmt, lint], Stop: [lint] });
    actual.entries.should.deepEqual([]);
    actual.problems.should.deepEqual([]);
  });

  it('should refuse an event that is not a list, and a document that could not be read', () => {
    // Arrange
    const components = {
      hooks: {
        bad: { harness: 'claude' as const, file: 'bad.json' },
        gone: { harness: 'claude' as const, file: 'gone.json' },
      },
    };

    // Act
    const actual = adapt('claude', components, ['hooks/bad', 'hooks/gone'], {
      bodies: { hooks: { bad: { Stop: { command: 'x' } } } },
    });

    // Assert
    actual.problems.should.deepEqual([
      {
        kind: 'unread',
        reference: 'hooks/gone',
        message: 'hooks "gone" could not be read, so its hooks cannot be added',
      },
      {
        kind: 'invalid-hooks',
        reference: 'hooks/bad',
        event: 'Stop',
        message: 'hooks "bad" gives Stop something other than a list of hooks',
      },
    ]);
  });

  it('should start from no hooks when the settings hold something that is not a hooks block', () => {
    // Act
    const actual = adapt('claude', { hooks: { fmt: { harness: 'claude', file: 'fmt.json' } } }, ['hooks/fmt'], {
      settings: { hooks: 'garbage' },
      bodies: { hooks: { fmt: { Stop: [1] } } },
    });

    // Assert
    should(actual.settings.value.hooks).deepEqual({ Stop: [1] });
  });

  it('should leave the settings alone with no hooks, and link a folder of hook scripts', () => {
    // Act
    const none = adapt('claude', { instructions: { m: { file: 'm.md' } } }, ['instructions/m']);
    const scripts = adapt('claude', { hooks: { dir: { harness: 'claude', directory: 'components/hooks/dir' } } }, [
      'hooks/dir',
    ]);

    // Assert
    should(none.settings.value.hooks).be.undefined();
    none.absent.should.containEql('hooks');
    scripts.entries.should.deepEqual([
      { kind: 'link', dest: 'hooks', source: 'components/hooks/dir', from: ['hooks/dir'] },
    ]);
  });
});

describe('adaptProfile — hooks on Codex', () => {
  it('should link one hooks document as hooks.json without reading it', () => {
    // Act
    const actual = adapt('codex', { hooks: { h: { harness: 'codex', file: 'components/hooks/h.json' } } }, ['hooks/h']);

    // Assert
    actual.entries.should.deepEqual([
      { kind: 'link', dest: 'hooks.json', source: 'components/hooks/h.json', from: ['hooks/h'] },
    ]);
    actual.problems.should.deepEqual([]);
    actual.absent.should.containEql('hooks');
  });

  it('should copy a hooks document or folder from outside the asset tree', () => {
    // Act
    const actual = adapt(
      'codex',
      { hooks: { h: { harness: 'codex', file: '/etc/h.json' }, d: { harness: 'codex', directory: '~/hooks' } } },
      ['hooks/h', 'hooks/d'],
    );

    // Assert
    actual.entries
      .map(({ kind, dest }) => ({ kind, dest }))
      .should.deepEqual([
        { kind: 'copy', dest: 'hooks' },
        { kind: 'copy', dest: 'hooks.json' },
      ]);
  });

  it('should generate hooks.json from several documents, all applying in layer order', () => {
    // Arrange
    const components = {
      hooks: { a: { harness: 'codex' as const, file: 'a.json' }, b: { harness: 'codex' as const, file: 'b.json' } },
    };

    // Act
    const actual = adapt('codex', components, ['hooks/a', 'hooks/b'], {
      bodies: { hooks: { a: { Stop: ['a'] }, b: { Stop: ['b'] } } },
    });

    // Assert
    actual.entries.should.deepEqual([
      {
        kind: 'generated',
        dest: 'hooks.json',
        content: '{\n  "hooks": {\n    "Stop": [\n      "a",\n      "b"\n    ]\n  }\n}\n',
        from: ['hooks/a', 'hooks/b'],
      },
    ]);
  });

  it('should write no hooks.json from several when one could not be read', () => {
    // Act
    const actual = adapt(
      'codex',
      { hooks: { a: { harness: 'codex', file: 'a.json' }, b: { harness: 'codex', file: 'b.json' } } },
      ['hooks/a', 'hooks/b'],
      { bodies: { hooks: { a: { Stop: [] } } } },
    );

    // Assert
    actual.entries.should.deepEqual([]);
    actual.problems.map(problem => problem.kind).should.deepEqual(['unread']);
  });

  it('should mark both hooks destinations absent with no hooks', () => {
    // Act
    const actual = adapt('codex', { instructions: { m: { file: 'm.md' } } }, ['instructions/m']);

    // Assert
    actual.absent.should.deepEqual(['hooks', 'hooks.json']);
  });

  it('should refuse several folders of hook scripts, keeping the newest in view', () => {
    // Act
    const actual = adapt(
      'codex',
      { hooks: { one: { harness: 'codex', directory: 'one' }, two: { harness: 'codex', directory: 'two' } } },
      ['hooks/one', 'hooks/two'],
    );

    // Assert
    actual.entries.should.deepEqual([{ kind: 'link', dest: 'hooks', source: 'two', from: ['hooks/two'] }]);
    actual.problems.should.deepEqual([
      {
        kind: 'several-hook-directories',
        references: ['hooks/one', 'hooks/two'],
        message:
          '2 hooks components each bring a folder of hook scripts ("one", "two"), but a runtime has one hooks folder: put the scripts in one folder',
      },
    ]);
  });
});

describe('adaptProfile — plumbing', () => {
  it("should set Claude's statusLine to the usage tee, with no command of the person's own", () => {
    // Act
    const actual = adapt('claude', { instructions: { m: { file: 'm.md' } } }, ['instructions/m']);

    // Assert
    actual.settings.should.deepEqual({
      dest: 'settings.json',
      format: 'json',
      value: { statusLine: { type: 'command', command: 'fy statusline' } },
    });
    actual.plumbing.map(entry => entry.key).should.deepEqual(['statusLine.type', 'statusLine.command']);
    actual.overrides.should.deepEqual([]);
  });

  it("should chain the person's own statusLine command and keep its other keys", () => {
    // Act
    const actual = adapt('claude', { settings: { s: { harness: 'claude', file: 's.json' } } }, ['settings/s'], {
      settingsBodies: { s: { statusLine: { type: 'command', command: 'my-line', padding: 2 } } },
    });

    // Assert
    should(actual.settings.value.statusLine).deepEqual({
      type: 'command',
      command: "fy statusline --then 'my-line'",
      padding: 2,
    });
    actual.overrides.should.deepEqual([]);
  });

  it('should treat a blank or missing statusLine command as none of their own', () => {
    // Act
    const blank = adapt('claude', { settings: { s: { harness: 'claude', file: 's.json' } } }, ['settings/s'], {
      settingsBodies: { s: { statusLine: { type: 'command', command: '  ' } } },
    });
    const scalar = adapt('claude', { settings: { s: { harness: 'claude', file: 's.json' } } }, ['settings/s'], {
      settingsBodies: { s: { statusLine: 'off' } },
    });

    // Assert
    should(blank.settings.value.statusLine).have.property('command', 'fy statusline');
    should(scalar.settings.value.statusLine).deepEqual({ type: 'command', command: 'fy statusline' });
  });

  it("should force Codex's credential file and the shared SQLite home, reporting what it replaced", () => {
    // Act
    const actual = adapt('codex', { settings: { s: { harness: 'codex', file: 'c.toml' } } }, ['settings/s'], {
      settingsBodies: { s: { cli_auth_credentials_store: 'keyring', sqlite_home: SQLITE_HOME, model: 'gpt-6' } },
    });

    // Assert
    actual.settings.should.deepEqual({
      dest: 'config.toml',
      format: 'toml',
      value: { cli_auth_credentials_store: 'file', sqlite_home: SQLITE_HOME, model: 'gpt-6' },
    });
    actual.overrides
      .map(({ key, value, by }) => ({ key, value, by }))
      .should.deepEqual([{ key: 'cli_auth_credentials_store', value: 'keyring', by: 'plumbing' }]);
  });

  it("should render the settings it is handed, such as an agent runtime's fixed-layer settings", () => {
    // Act
    const actual = adapt('codex', { instructions: { m: { file: 'm.md' } } }, ['instructions/m'], {
      settings: { approval_policy: 'never' },
    });

    // Assert
    actual.settings.value.should.have.property('approval_policy', 'never');
  });

  it("should write no plumbing when handed the other harness's", () => {
    // Act
    const actual = adapt('codex', { instructions: { m: { file: 'm.md' } } }, ['instructions/m'], {
      plumbing: plumbingFor('claude'),
    });

    // Assert
    actual.plumbing.should.deepEqual([]);
    actual.settings.value.should.deepEqual({});
    actual.problems.should.deepEqual([
      { kind: 'harness-mismatch', message: "a Codex runtime was given Claude Code's plumbing" },
    ]);
  });
});

describe('componentPartialSupport', () => {
  it('should declare a skill limiting its tools as partly supported on Codex (E22)', () => {
    // Act
    const actual = componentPartialSupport({
      components: { instructions: {}, mcp: {}, skills: { mine: { items: ['release-notes', 'plain'] } } },
      skillFrontmatter: { 'release-notes': ['name', 'allowed-tools', 'model', 'hooks'], plain: ['name'] },
    });

    // Assert
    actual.should.deepEqual([
      {
        reference: 'skills/mine',
        harness: 'codex',
        reason: 'release-notes limits which tools it may use. Codex ignores that limit and loads the rest.',
      },
      {
        reference: 'skills/mine',
        harness: 'codex',
        reason: "release-notes picks its own model. Codex ignores that and uses the runtime's model.",
      },
      {
        reference: 'skills/mine',
        harness: 'codex',
        reason: 'release-notes carries its own hooks. Codex ignores them and loads the rest.',
      },
    ]);
    describePartialSupport(actual[0] as (typeof actual)[number]).should.equal(
      'Partly supported on Codex: release-notes limits which tools it may use. Codex ignores that limit and loads the rest.',
    );
  });

  it('should declare instructions with @path imports and an SSE server as partly supported on Codex', () => {
    // Act
    const actual = componentPartialSupport({
      components: {
        instructions: {
          main: { file: 'm.md' },
          plain: { file: 'p.md' },
          unread: { file: 'u.md' },
          claudeOnly: { file: 'c.md', harness: 'claude' },
        },
        mcp: {
          linear: { url: 'https://mcp.linear.app/sse' },
          api: { url: 'https://mcp.example.com/mcp' },
          local: { command: 'uvx' },
          claudeSse: { url: 'https://x.example.com/sse', harness: 'claude' },
        },
        skills: { claudeSkills: { items: ['release-notes'], harness: 'claude' } },
      },
      skillFrontmatter: { 'release-notes': ['allowed-tools'] },
      instructionBodies: { main: 'Read this.\n@docs/style.md\n', plain: 'Mail me@example.com.', claudeOnly: '@x.md' },
    });

    // Assert
    actual.should.deepEqual([
      {
        reference: 'instructions/main',
        harness: 'codex',
        reason:
          'main pulls in other files with @path lines. Codex reads those lines as plain text and does not open the files.',
      },
      {
        reference: 'mcp/linear',
        harness: 'codex',
        reason:
          'linear is reached over SSE. Codex connects to servers over streamable HTTP, so it may not reach this one.',
      },
    ]);
  });

  it('should declare nothing without the facts it is decided from', () => {
    // Act
    const actual = componentPartialSupport({
      components: { instructions: {}, mcp: {}, skills: { mine: { items: ['release-notes'] } } },
    });

    // Assert
    actual.should.deepEqual([]);
  });

  it('should be the table layering carries through to a runtime', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      components: { skills: { mine: { items: ['release-notes'] } } },
      profiles: { p: { layers: ['skills/mine'] } },
    });
    const partialSupport = componentPartialSupport({
      components: model.components,
      skillFrontmatter: { 'release-notes': ['allowed-tools'] },
    });

    // Act
    const codex = resolveProfile({ model, profile: 'p', harness: 'codex', partialSupport });
    const claude = resolveProfile({ model, profile: 'p', harness: 'claude', partialSupport });

    // Assert
    if (!codex.ok || !claude.ok) throw new Error('unexpected');
    codex.resolved.partial.should.deepEqual(partialSupport);
    claude.resolved.partial.should.deepEqual([]);
    should(partialSupportBadge(codex.resolved.partial, 'codex')).equal('Partly supported on Codex');
    should(partialSupportBadge(claude.resolved.partial, 'claude')).be.undefined();
  });

  it('should declare only keys it can explain', () => {
    // Assert
    Object.keys(CODEX_IGNORED_SKILL_KEYS).should.deepEqual(['allowed-tools', 'model', 'hooks']);
  });
});

describe('skillFrontmatterKeys', () => {
  it('should read the top-level keys of a frontmatter block, once each', () => {
    // Act
    const actual = skillFrontmatterKeys(
      '﻿---\r\nname: notes\r\nallowed-tools:\r\n  - Read\r\nname: again\r\n---\r\nallowed-tools: body\n',
    );

    // Assert
    actual.should.deepEqual(['name', 'allowed-tools']);
  });

  it('should read nothing from text with no frontmatter, or an unterminated block', () => {
    // Assert
    skillFrontmatterKeys('# Title\nmodel: x').should.deepEqual([]);
    skillFrontmatterKeys('---\nmodel: x\n').should.deepEqual([]);
    skillFrontmatterKeys('').should.deepEqual([]);
  });
});

describe('adaptation helpers', () => {
  it('should tell an SSE url from a streamable HTTP one by its last path segment', () => {
    // Assert
    isSseUrl('https://mcp.linear.app/SSE//').should.be.true();
    isSseUrl('https://mcp.example.com/sse/messages').should.be.false();
    isSseUrl('https://mcp.example.com').should.be.false();
  });

  it('should spot a Claude @path import line and nothing else', () => {
    // Assert
    usesClaudeImports('Intro\n  @docs/a.md  \nmore').should.be.true();
    usesClaudeImports('write to me@example.com').should.be.false();
    usesClaudeImports('@ alone').should.be.false();
  });

  it('should concatenate instructions under a header naming each source', () => {
    // Act
    const actual = concatenateInstructions([{ reference: 'instructions/a', body: '\nA\n' }]);

    // Assert
    actual.should.equal('<!-- Generated from instructions/a. Edit those components, not this file. -->\n\nA\n');
  });
});
