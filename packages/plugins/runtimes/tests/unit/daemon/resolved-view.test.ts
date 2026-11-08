import { describe, it } from 'bun:test';
import should from 'should';
import { type ResolvedProfile, type ResolveInput, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

const HIDDEN = '‹hidden›';
// Obviously fake: it only has to have the shape of a provider token so the secret rules see it.
const FAKE_TOKEN = 'sk-not-a-real-key-0000';

const modelWith = (components: Record<string, unknown>, profiles: Record<string, unknown>) =>
  parseAccountModel({ version: 1, components, profiles });

const resolved = (input: ResolveInput): ResolvedProfile => {
  const result = resolveProfile(input);
  if (!result.ok) throw new Error(`expected a resolution, got ${JSON.stringify(result.failure)}`);
  return result.resolved;
};

/** The one entry of this field and key, or a thrown error naming what was missing. */
const entryOf = (entries: ReturnType<typeof resolvedEntries>, field: string, key: string) => {
  const found = entries.find(entry => entry.field === field && entry.key === key);
  if (found === undefined) throw new Error(`no ${field} entry named ${key}`);
  return found;
};

describe('resolvedEntries', () => {
  it('should say every final value with the profile item it came from, in merge order', () => {
    // Arrange
    const model = modelWith(
      {
        instructions: { guide: { file: 'components/instructions/guide.md' } },
        mcp: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } },
        skills: { tools: { items: ['lint', 'format'] } },
        settings: { base: { harness: 'claude', file: 'base.json', flags: ['--verbose'], env: { LOG_LEVEL: 'info' } } },
        hooks: { fmt: { harness: 'claude', file: 'fmt.json' }, tree: { harness: 'claude', directory: 'hooks-dir' } },
        modelSets: { models: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
      },
      {
        p: {
          layers: [
            'instructions/guide',
            'mcp/github',
            'skills/tools',
            'settings/base',
            'hooks/fmt',
            'hooks/tree',
            'modelSets/models',
          ],
        },
      },
    );

    // Act
    const actual = resolvedEntries(
      resolved({ model, profile: 'p', harness: 'claude', settingsBodies: { base: { theme: 'dark' } } }),
    );

    // Assert
    should(actual.map(entry => [entry.field, entry.key, entry.value, entry.from])).deepEqual([
      ['instructions', 'guide', 'components/instructions/guide.md', 'instructions/guide'],
      ['mcp', 'github', 'npx -y gh-mcp', 'mcp/github'],
      ['skills', 'lint', 'included', 'skills/tools'],
      ['skills', 'format', 'included', 'skills/tools'],
      ['settings', 'theme', 'dark', 'settings/base'],
      ['env', 'env.LOG_LEVEL', 'info', 'settings/base'],
      ['flags', 'flag', '--verbose', 'settings/base'],
      ['hooks', 'fmt', 'fmt.json', 'hooks/fmt'],
      ['hooks', 'tree', 'hooks-dir', 'hooks/tree'],
      ['model', 'model', 'claude-opus-5-5', 'modelSets/models'],
    ]);
    should(actual.every(entry => entry.harness === 'claude-code')).be.true();
    should(actual.every(entry => entry.overridden.length === 0)).be.true();
  });

  it('should list the earlier values a newer layer beat, settings and environment alike', () => {
    // Arrange
    const model = modelWith(
      {
        settings: {
          base: { harness: 'claude', file: 'base.json', env: { LOG_LEVEL: 'info' } },
          over: { harness: 'claude', file: 'over.json', env: { LOG_LEVEL: 'debug' } },
        },
      },
      { p: { layers: ['settings/base', 'settings/over'] } },
    );

    // Act
    const actual = resolvedEntries(
      resolved({
        model,
        profile: 'p',
        harness: 'claude',
        settingsBodies: { base: { theme: 'light' }, over: { theme: 'dark' } },
      }),
    );

    // Assert
    should(entryOf(actual, 'settings', 'theme')).containDeep({
      value: 'dark',
      from: 'settings/over',
      overridden: [{ value: 'light', from: 'settings/base' }],
    });
    should(entryOf(actual, 'env', 'env.LOG_LEVEL')).containDeep({
      value: 'debug',
      from: 'settings/over',
      overridden: [{ value: 'info', from: 'settings/base' }],
    });
  });

  it('should say a model set the newest layer chose and the default it beat', () => {
    // Arrange
    const model = modelWith(
      {
        modelSets: {
          heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
          light: { models: ['claude-haiku-5-5', 'claude-opus-5-5'], default: 'claude-haiku-5-5' },
        },
      },
      { p: { layers: ['modelSets/heavy', 'modelSets/light'] } },
    );

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(actual).have.length(1);
    should(actual[0]).containDeep({
      field: 'model',
      value: 'claude-haiku-5-5',
      from: 'modelSets/light',
      overridden: [{ value: 'claude-opus-5-5', from: 'modelSets/heavy' }],
    });
  });

  it('should list no model when no model set applies and leave the harness to pick', () => {
    // Arrange
    const model = modelWith(
      { instructions: { guide: { file: 'guide.md' } } },
      { p: { layers: ['instructions/guide'] } },
    );

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'codex' }));

    // Assert
    should(actual.map(entry => entry.field)).deepEqual(['instructions']);
    should(actual[0]?.harness).equal('codex');
  });

  it('should hide a credential-looking setting, environment value, flag and argument, along with what it beat', () => {
    // Arrange
    const model = modelWith(
      {
        mcp: { local: { command: 'run-server', args: ['--key', FAKE_TOKEN, '--plain'] } },
        settings: {
          base: {
            harness: 'claude',
            file: 'base.json',
            flags: [FAKE_TOKEN],
            env: { API_TOKEN: 'older-value-123' },
          },
          over: { harness: 'claude', file: 'over.json', env: { API_TOKEN: 'newer-value-456' } },
        },
      },
      { p: { layers: ['mcp/local', 'settings/base', 'settings/over'] } },
    );

    // Act
    const actual = resolvedEntries(
      resolved({
        model,
        profile: 'p',
        harness: 'claude',
        settingsBodies: { base: { auth_token: 'older-setting-123' }, over: { auth_token: 'newer-setting-456' } },
      }),
    );

    // Assert
    should(entryOf(actual, 'mcp', 'local').value).equal(`run-server --key ${HIDDEN} --plain`);
    should(entryOf(actual, 'settings', 'auth_token')).containDeep({
      value: HIDDEN,
      hidden: true,
      overridden: [{ value: HIDDEN, hidden: true }],
    });
    should(entryOf(actual, 'env', 'env.API_TOKEN')).containDeep({
      value: HIDDEN,
      hidden: true,
      overridden: [{ value: HIDDEN, hidden: true }],
    });
    should(entryOf(actual, 'flags', 'flag')).containDeep({ value: HIDDEN, hidden: true });
    should(JSON.stringify(actual))
      .not.containEql('value-123')
      .and.not.containEql('value-456')
      .and.not.containEql(FAKE_TOKEN);
  });

  it('should say a url server by where it is reached, without its user, query or fragment', () => {
    // Arrange
    const model = modelWith(
      { mcp: { remote: { url: 'https://user:pass@mcp.example.test/sse?key=abc#frag' } } },
      { p: { layers: ['mcp/remote'] } },
    );

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'remote').value).equal('https://mcp.example.test/sse');
  });

  it('should hide a server url it cannot parse rather than print it', () => {
    // Arrange — the schema refuses this document, so the catalogue is built past it.
    const model = {
      components: {
        instructions: {},
        mcp: { odd: { url: 'not a url?secret=1' } },
        skills: {},
        settings: {},
        hooks: {},
        modelSets: {},
      },
      profiles: { p: { layers: ['mcp/odd'] } },
    } as unknown as ResolveInput['model'];

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'odd').value).equal(HIDDEN);
  });

  it('should write a command-less server as its arguments alone and skip empty words', () => {
    // Arrange
    const model = {
      components: {
        instructions: {},
        mcp: { bare: { args: ['', 'only'] } },
        skills: {},
        settings: {},
        hooks: {},
        modelSets: {},
      },
      profiles: { p: { layers: ['mcp/bare'] } },
    } as unknown as ResolveInput['model'];

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'bare').value).equal('only');
  });

  it('should write a server with neither command nor arguments as nothing', () => {
    // Arrange
    const model = {
      components: { instructions: {}, mcp: { empty: {} }, skills: {}, settings: {}, hooks: {}, modelSets: {} },
      profiles: { p: { layers: ['mcp/empty'] } },
    } as unknown as ResolveInput['model'];

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'empty').value).equal('');
  });

  it('should write a non-text setting as JSON', () => {
    // Arrange
    const model = modelWith(
      { settings: { base: { harness: 'claude', file: 'base.json' } } },
      { p: { layers: ['settings/base'] } },
    );

    // Act
    const actual = resolvedEntries(
      resolved({ model, profile: 'p', harness: 'claude', settingsBodies: { base: { retries: 3, quiet: true } } }),
    );

    // Assert
    should(entryOf(actual, 'settings', 'retries').value).equal('3');
    should(entryOf(actual, 'settings', 'quiet').value).equal('true');
  });
});

// FINDING (ported unchanged from 4.291.5, packages/daemon/src/lib/fleet/resolved-view.ts): a launch flag is judged by
// `looksSecret('', flag)`, whose value-prefix rule is anchored at the start, so `--token=<token>` is listed in full.
// Not fixed here: it is a behaviour change, not a coverage change. Reported to the review lead.
describe('resolvedEntries — known gap', () => {
  it.todo('should hide a token glued to a flag name, as in --token=<token>');
});
