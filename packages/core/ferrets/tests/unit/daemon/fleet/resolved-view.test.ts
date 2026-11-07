/**
 * The Resolved view's projection (R5): every final value one harness gets, the content item it came
 * from, what it overrode — and no credential-looking value, ever.
 */
import { describe, it } from 'bun:test';
import { type HarnessKind, parseAccountModel, type ResolvedProfile, resolveProfile } from '@ferretry/fleet';
import { FleetResolvedEntrySchema } from '@ferretry/protocol';
import should from 'should';
import { RESOLVED_HIDDEN_TEXT, resolvedEntries } from '../../../src/lib/fleet/resolved-view.ts';

const FAKE_TOKEN = ['sk-', 'abcdefghijklmnop'].join('');

const model = () =>
  parseAccountModel({
    version: 2,
    components: {
      instructions: { rules: { file: 'rules.md' } },
      mcp: {
        github: { command: 'npx', args: ['-y', '@github/mcp', FAKE_TOKEN] },
        remote: { url: 'https://user:pw@mcp.example.com/v1/mcp?key=abc#frag' },
      },
      skills: { mine: { items: ['alpha', 'beta'] }, more: { items: ['beta'] } },
      settings: {
        base: { harness: 'claude', file: 'settings/base.json', env: { MODE: 'one', API_KEY: FAKE_TOKEN } },
        agent: { harness: 'claude', file: 'settings/agent.json', env: { MODE: 'two' }, flags: ['--verbose'] },
      },
      hooks: {
        notify: { harness: 'claude', file: 'hooks/notify.json' },
        scripts: { harness: 'claude', directory: 'hooks/scripts' },
      },
      modelSets: {
        sonnet: { models: ['claude-sonnet-5'], default: 'claude-sonnet-5' },
        opus: { models: ['claude-opus-5'], default: 'claude-opus-5' },
      },
    },
    profiles: {
      base: { layers: ['instructions/rules', 'settings/base', 'modelSets/sonnet', 'skills/mine'] },
      agent: {
        layers: [
          'profile/base',
          'mcp/github',
          'mcp/remote',
          'skills/more',
          'settings/agent',
          'hooks/notify',
          'hooks/scripts',
          'modelSets/opus',
        ],
      },
      empty: { layers: ['instructions/rules'] },
    },
  });

const BODIES = {
  base: { permissions: { defaultMode: 'plan' }, theme: 'dark' },
  agent: { permissions: { defaultMode: 'acceptEdits' }, password: 'hunter2-hunter2' },
};

const resolve = (profile: string, harness: HarnessKind = 'claude'): ResolvedProfile => {
  const result = resolveProfile({ model: model(), profile, harness, settingsBodies: BODIES });
  if (!result.ok) throw new Error('unresolvable');
  return result.resolved;
};

describe('resolvedEntries', () => {
  it('should list every final value in merge order, each tagged with the content item it came from', () => {
    // Act
    const entries = resolvedEntries(resolve('agent'));

    // Assert
    should(entries.map(entry => [entry.field, entry.key, entry.value, entry.from])).deepEqual([
      ['instructions', 'rules', 'rules.md', 'profile/base'],
      ['mcp', 'github', `npx -y @github/mcp ${RESOLVED_HIDDEN_TEXT}`, 'mcp/github'],
      ['mcp', 'remote', 'https://mcp.example.com/v1/mcp', 'mcp/remote'],
      ['skills', 'alpha', 'included', 'profile/base'],
      ['skills', 'beta', 'included', 'skills/more'],
      ['settings', 'theme', 'dark', 'profile/base'],
      ['settings', 'permissions.defaultMode', 'acceptEdits', 'settings/agent'],
      ['settings', 'password', RESOLVED_HIDDEN_TEXT, 'settings/agent'],
      ['env', 'env.MODE', 'two', 'settings/agent'],
      ['env', 'env.API_KEY', RESOLVED_HIDDEN_TEXT, 'profile/base'],
      ['flags', 'flag', '--verbose', 'settings/agent'],
      ['hooks', 'notify', 'hooks/notify.json', 'hooks/notify'],
      ['hooks', 'scripts', 'hooks/scripts', 'hooks/scripts'],
      ['model', 'model', 'claude-opus-5', 'modelSets/opus'],
    ]);
    for (const entry of entries) FleetResolvedEntrySchema.parse(entry);
  });

  it('should carry each value a later item overrode, and mark a hidden one', () => {
    // Act
    const entries = resolvedEntries(resolve('agent'));
    const find = (key: string) => entries.find(entry => entry.key === key);

    // Assert
    should(find('permissions.defaultMode')?.overridden).deepEqual([{ value: 'plan', from: 'profile/base' }]);
    should(find('env.MODE')?.overridden).deepEqual([{ value: 'one', from: 'profile/base' }]);
    should(find('model')?.overridden).deepEqual([{ value: 'claude-sonnet-5', from: 'profile/base' }]);
    should(find('password')).containEql({ hidden: true, overridden: [] });
    should(find('theme')).not.have.property('hidden');
  });

  it('should say only what the harness gets, and nothing about a model when no set applies', () => {
    // Act
    const codex = resolvedEntries(resolve('agent', 'codex'));
    const plain = resolvedEntries(resolve('empty'));

    // Assert
    should(codex.every(entry => entry.harness === 'codex')).be.true();
    should(codex.map(entry => entry.field)).not.containEql('settings');
    should(plain.map(entry => entry.field)).deepEqual(['instructions']);
  });

  it('should hide a server address it cannot read rather than show it', () => {
    // Arrange: a URL the schema accepted can still be one `URL` refuses only in a hand-built model.
    const resolved = resolve('agent');
    const odd = {
      ...resolved,
      mcp: [{ ...(resolved.mcp[0] as ResolvedProfile['mcp'][number]), component: { url: 'not a url' } }],
    } as ResolvedProfile;

    // Act
    const entries = resolvedEntries(odd);

    // Assert
    should(entries.find(entry => entry.field === 'mcp')?.value).equal(RESOLVED_HIDDEN_TEXT);
  });
});
