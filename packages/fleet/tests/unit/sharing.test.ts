/**
 * The shared-asset domain: what a fleet declares, who uses it, and what can never be shared.
 *
 * Every fixture is parsed through `FleetConfigSchema` rather than hand-built, so each test runs against
 * a configuration a person could actually write — which is the only way the "identity is never shared"
 * assertions mean anything, since the enforcement is the schema's strictness.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ASSET_FIELD_SHAPES, ASSET_FIELDS } from '../../src/lib/assets.ts';
import { BaseProfileSchema, type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import {
  accountAssetPath,
  accountSharing,
  DEFAULT_SHARED_NAME,
  LINKABLE_FIELDS,
  PER_ACCOUNT_FIELDS,
  resolveFleetSharing,
  SHAREABLE_FIELDS,
  sharedAssetNames,
  sharedAssetPath,
  unlinkableReason,
  unreadableSourceReason,
} from '../../src/lib/sharing.ts';

const ID_ONE = '00000000-0000-4000-8000-0000000000a1';
const ID_TWO = '00000000-0000-4000-8000-0000000000a2';
const ID_THREE = '00000000-0000-4000-8000-0000000000a3';

const parse = (input: Record<string, unknown>): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`fixture is not valid configuration: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  return parsed.data;
};

const route = (id: string, wrapper: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  wrapper,
  home: wrapper,
  defaultModel: 'model-one',
  models: ['model-one'],
  ...overrides,
});

/** Two Claude accounts on one shared memory document, declared under its conventional name. */
const twoSharedAccounts = (): FleetConfig =>
  parse({
    shared: { memory: { [DEFAULT_SHARED_NAME]: './CLAUDE.md' } },
    profiles: { base: { memory: './CLAUDE.md' } },
    variants: { default: {} },
    agents: [
      { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } },
      { name: 'two', kind: 'claude', routes: { default: route(ID_TWO, 'claude-two') } },
    ],
  });

describe('the shared asset registry', () => {
  it('should default to declaring nothing for every asset field', () => {
    // Act
    const config = parse({ variants: { default: {} } });

    // Assert — a field missing from the registry is an empty registry for that field, never absent:
    // a consumer reading `config.shared.skills` must never have to guard for undefined.
    should(Object.keys(config.shared).toSorted()).deepEqual([...ASSET_FIELDS].toSorted());
    for (const field of ASSET_FIELDS) should(config.shared[field]).deepEqual({});
  });

  it('should resolve a declared name to its path and report the names it declares', () => {
    // Arrange
    const config = twoSharedAccounts();

    // Act / Assert
    should(sharedAssetPath(config, 'memory', DEFAULT_SHARED_NAME)).equal('./CLAUDE.md');
    should(sharedAssetPath(config, 'memory', 'terse')).be.undefined();
    should(sharedAssetNames(config, 'memory')).deepEqual([DEFAULT_SHARED_NAME]);
    should(sharedAssetNames(config, 'skills')).deepEqual([]);
  });

  it('should refuse two names for one document, comparing paths canonically', () => {
    // Act
    const parsed = FleetConfigSchema.safeParse({
      shared: { memory: { default: './CLAUDE.md', alias: 'CLAUDE.md' } },
      variants: { default: {} },
    });

    // Assert — `./CLAUDE.md` and `CLAUDE.md` are one file, so admitting both names would leave "which
    // shared document is this account on" with two answers.
    should(parsed.success).be.false();
    should(parsed.error?.issues.map(issue => issue.message).join('\n')).match(/same document as "default"/u);
  });

  it('should allow one document to carry a name under two different fields', () => {
    // Act — the duplicate check is per field on purpose: one file being both a memory document and a
    // settings layer is unusual but coherent, and refusing it would be a rule about nothing.
    const config = parse({
      shared: { memory: { default: './shared.md' }, mcp: { default: './shared.md' } },
      variants: { default: {} },
    });

    // Assert
    should(sharedAssetPath(config, 'memory', 'default')).equal('./shared.md');
    should(sharedAssetPath(config, 'mcp', 'default')).equal('./shared.md');
  });
});

describe('resolveFleetSharing', () => {
  it('should report a declared document as shared, with its name, slot and every account on it', () => {
    // Act
    const sharing = resolveFleetSharing(twoSharedAccounts());

    // Assert — the document names both accounts, and each account reports the shared state without a
    // consumer having to compare any strings itself.
    should(sharing.documents).deepEqual([
      { field: 'memory', name: DEFAULT_SHARED_NAME, path: './CLAUDE.md', accounts: [ID_ONE, ID_TWO] },
    ]);
    should(accountSharing(sharing, ID_ONE)?.fields.memory).deepEqual({
      state: 'shared',
      name: DEFAULT_SHARED_NAME,
      path: './CLAUDE.md',
      origin: { kind: 'base-profile', name: 'base' },
      referrers: 2,
    });
  });

  it('should recognise a shared document reached by a differently spelled path', () => {
    // Arrange — the starter configuration writes `./CLAUDE.md`; a person editing it writes `CLAUDE.md`.
    const config = parse({
      shared: { memory: { default: './CLAUDE.md' } },
      variants: { default: {} },
      agents: [
        {
          name: 'one',
          kind: 'claude',
          routes: { default: route(ID_ONE, 'claude-one', { layer: { memory: 'CLAUDE.md' } }) },
        },
      ],
    });

    // Act
    const sharing = resolveFleetSharing(config);

    // Assert
    should(accountSharing(sharing, ID_ONE)?.fields.memory).match({ state: 'shared', name: 'default' });
  });

  it('should report an undeclared path as local, and count the accounts already sharing it', () => {
    // Arrange — no registry at all, but the base profile still points both accounts at one document.
    const config = parse({
      profiles: { base: { memory: './CLAUDE.md' } },
      variants: { default: {} },
      agents: [
        { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } },
        { name: 'two', kind: 'claude', routes: { default: route(ID_TWO, 'claude-two') } },
      ],
    });

    // Act
    const sharing = resolveFleetSharing(config);

    // Assert — `local` with two referrers is a fleet sharing something it never declared, which is a
    // state a surface should offer to fix rather than one it should read as "private".
    should(accountSharing(sharing, ID_ONE)?.fields.memory).deepEqual({
      state: 'local',
      path: './CLAUDE.md',
      origin: { kind: 'base-profile', name: 'base' },
      referrers: 2,
    });
    should(sharing.documents).deepEqual([]);
  });

  it('should report a field no slot declares as absent rather than as an empty path', () => {
    // Act
    const sharing = resolveFleetSharing(twoSharedAccounts());

    // Assert
    should(accountSharing(sharing, ID_ONE)?.fields.skills).deepEqual({ state: 'absent' });
    should(accountSharing(sharing, ID_ONE)?.fields.hooks).deepEqual({ state: 'absent' });
    should(accountSharing(sharing, ID_ONE)?.fields.hooksDir).deepEqual({ state: 'absent' });
    should(accountSharing(sharing, ID_ONE)?.fields.mcp).deepEqual({ state: 'absent' });
  });

  it('should attribute a value to the last slot that supplied it, not the first', () => {
    // Arrange — every slot in the chain names a memory document, so only the last may be reported.
    const config = parse({
      shared: { memory: { default: './CLAUDE.md' } },
      profiles: { base: { memory: './base.md' }, agentish: { memory: './agent-profile.md' } },
      variants: { default: { memory: './variant.md' } },
      agents: [
        {
          name: 'one',
          kind: 'claude',
          profiles: ['agentish'],
          memory: './agent.md',
          routes: { default: route(ID_ONE, 'claude-one', { layer: { memory: './CLAUDE.md' } }) },
        },
      ],
    });

    // Act
    const sharing = resolveFleetSharing(config);

    // Assert
    should(accountSharing(sharing, ID_ONE)?.fields.memory).deepEqual({
      state: 'shared',
      name: 'default',
      path: './CLAUDE.md',
      origin: { kind: 'account' },
      referrers: 1,
    });
  });

  it('should attribute a value supplied by a lane and by an agent to those slots', () => {
    // Arrange
    const config = parse({
      profiles: { lane: { mcp: './lane-profile.json' } },
      variants: { default: { profiles: ['lane'], skills: './lane-skills' } },
      agents: [
        {
          name: 'one',
          kind: 'claude',
          memory: './agent.md',
          routes: { default: route(ID_ONE, 'claude-one') },
        },
      ],
    });

    // Act
    const account = accountSharing(resolveFleetSharing(config), ID_ONE);

    // Assert — each of the four shared slots is reported as itself, so a person is told where to edit.
    should(account?.fields.skills).match({ origin: { kind: 'variant', name: 'default' } });
    should(account?.fields.mcp).match({ origin: { kind: 'variant-profile', name: 'lane' } });
    should(account?.fields.memory).match({ origin: { kind: 'agent', name: 'one' } });
  });

  it('should attribute a value from an agent-listed profile to that profile', () => {
    // Arrange
    const config = parse({
      profiles: { house: { memory: './house.md' } },
      variants: { default: {} },
      agents: [{ name: 'one', kind: 'claude', profiles: ['house'], routes: { default: route(ID_ONE, 'claude-one') } }],
    });

    // Act / Assert
    should(accountSharing(resolveFleetSharing(config), ID_ONE)?.fields.memory).match({
      origin: { kind: 'agent-profile', name: 'house' },
    });
  });

  it('should let a harness overlay win inside its own slot', () => {
    // Arrange — the overlay is applied after the slot's flat fields, so the Codex account must read the
    // overlay document and the Claude account the flat one.
    const config = parse({
      shared: { memory: { flat: './flat.md', codexish: './codex.md' } },
      profiles: { base: { memory: './flat.md', codex: { memory: './codex.md' } } },
      variants: { default: {} },
      agents: [
        { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } },
        { name: 'two', kind: 'codex', routes: { default: route(ID_TWO, 'codex-two') } },
      ],
    });

    // Act
    const sharing = resolveFleetSharing(config);

    // Assert
    should(accountSharing(sharing, ID_ONE)?.fields.memory).match({ state: 'shared', name: 'flat' });
    should(accountSharing(sharing, ID_TWO)?.fields.memory).match({ state: 'shared', name: 'codexish' });
  });

  it('should classify every settings layer in merge order without offering to link one', () => {
    // Arrange
    const config = parse({
      shared: { settings: { claude: './templates/claude/settings.json' } },
      profiles: { base: { settings: ['./templates/claude/settings.json', { model: 'opus' }] } },
      variants: { default: {} },
      agents: [
        {
          name: 'one',
          kind: 'claude',
          routes: { default: route(ID_ONE, 'claude-one', { layer: { settings: './own.json' } }) },
        },
      ],
    });

    // Act
    const account = accountSharing(resolveFleetSharing(config), ID_ONE);

    // Assert — position is the merge order, a document layer carries its shared name when it has one,
    // and `settings` never appears among the linkable fields.
    should(account?.settings).deepEqual([
      {
        position: 0,
        kind: 'document',
        path: './templates/claude/settings.json',
        name: 'claude',
        origin: { kind: 'base-profile', name: 'base' },
        referrers: 1,
      },
      { position: 1, kind: 'inline', origin: { kind: 'base-profile', name: 'base' } },
      {
        position: 2,
        kind: 'document',
        path: './own.json',
        name: undefined,
        origin: { kind: 'account' },
        referrers: 1,
      },
    ]);
    should(account?.linkable).not.containEql('settings');
  });

  it('should count one account naming a settings document twice as one referrer', () => {
    // Arrange — the same base layer listed by two slots is one account using one document.
    const config = parse({
      shared: { settings: { base: './base.json' } },
      profiles: { base: { settings: './base.json' } },
      variants: { default: { settings: './base.json' } },
      agents: [{ name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } }],
    });

    // Act
    const sharing = resolveFleetSharing(config);

    // Assert
    should(sharing.documents).deepEqual([{ field: 'settings', name: 'base', path: './base.json', accounts: [ID_ONE] }]);
    should(sharing.accounts[0]?.settings.map(layer => (layer.kind === 'document' ? layer.referrers : -1))).deepEqual([
      1, 1,
    ]);
  });

  it('should report a declared document nobody uses rather than dropping it', () => {
    // Arrange
    const config = parse({
      shared: { memory: { unused: './nobody.md' } },
      variants: { default: {} },
      agents: [{ name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } }],
    });

    // Act / Assert — a document with no accounts is exactly what "offer this to somebody" needs.
    should(resolveFleetSharing(config).documents).deepEqual([
      { field: 'memory', name: 'unused', path: './nobody.md', accounts: [] },
    ]);
  });

  it('should exclude a field the account harness has no destination for from linkable', () => {
    // Arrange
    const config = parse({
      variants: { default: {} },
      agents: [
        { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } },
        { name: 'two', kind: 'codex', routes: { default: route(ID_TWO, 'codex-two') } },
      ],
    });

    // Act
    const sharing = resolveFleetSharing(config);

    // Assert — Claude has no hooks destinations and Codex has no MCP one, so neither is offered.
    should(accountSharing(sharing, ID_ONE)?.linkable).deepEqual(['memory', 'skills', 'mcp']);
    should(accountSharing(sharing, ID_TWO)?.linkable).deepEqual(['memory', 'skills', 'hooks', 'hooksDir']);
  });

  it('should carry each account identity through so a surface never joins on a name', () => {
    // Arrange
    const config = parse({
      variants: { default: {} },
      agents: [
        {
          name: 'one',
          kind: 'claude',
          routes: { default: route(ID_ONE, 'claude-one', { displayName: 'Claude (one)' }) },
        },
        { name: 'two', kind: 'codex', routes: { default: route(ID_TWO, 'codex-two') } },
      ],
    });

    // Act
    const sharing = resolveFleetSharing(config);

    // Assert — a route with no display name falls back to its wrapper, never to an empty string.
    should(sharing.accounts.map(account => [account.accountId, account.wrapper, account.displayName])).deepEqual([
      [ID_ONE, 'claude-one', 'Claude (one)'],
      [ID_TWO, 'codex-two', 'codex-two'],
    ]);
  });

  it('should answer for an account this fleet does not declare with nothing', () => {
    // Act / Assert
    should(accountSharing(resolveFleetSharing(twoSharedAccounts()), ID_THREE)).be.undefined();
  });
});

describe('what may never be shared', () => {
  it('should keep every per-account field out of everything a profile can express', () => {
    // Arrange — the profile shape is the complete set of fields any shared slot can carry, read from
    // the schema rather than restated, so this is a statement about what the parser accepts.
    const profileFields = new Set(Object.keys(BaseProfileSchema.shape));

    // Assert — identity, provider login, lane, mode, display name and default model are all absent
    // from it, which is why no shared document can flatten a fleet into one indistinguishable account.
    for (const field of PER_ACCOUNT_FIELDS) should(profileFields.has(field)).be.false();
    should([...profileFields].toSorted()).deepEqual(
      ['env', 'flags', 'settings', 'memory', 'skills', 'hooks', 'hooksDir', 'mcp'].toSorted(),
    );
  });

  it('should refuse a profile that tries to carry identity, auth or a home', () => {
    // Act / Assert — one case per family, because each would be a different kind of disaster: a shared
    // home means two accounts on one credential store, and a shared auth mode means a login that
    // authenticates the wrong account.
    for (const field of ['home', 'auth', 'identity', 'id', 'wrapper', 'defaultModel']) {
      const parsed = FleetConfigSchema.safeParse({
        variants: { default: {} },
        profiles: { base: { [field]: 'anything' } },
      });
      should(parsed.success).be.false();
    }
  });

  it('should reserve the variables that would detach an account from its own home', () => {
    // Act
    const parsed = FleetConfigSchema.safeParse({
      variants: { default: {} },
      profiles: { base: { env: { CLAUDE_CONFIG_DIR: '/elsewhere' } } },
    });

    // Assert — a shared env layer is allowed; one that rebinds a harness home is not.
    should(parsed.success).be.false();
    should(parsed.error?.issues.map(issue => issue.message).join('\n')).match(/is reserved/u);
  });

  it('should keep the shareable and linkable sets in step with the asset fields', () => {
    // Assert — sharing covers every asset field, and linking covers all but the layered one.
    should([...SHAREABLE_FIELDS].toSorted()).deepEqual([...ASSET_FIELDS].toSorted());
    should([...LINKABLE_FIELDS].toSorted()).deepEqual(ASSET_FIELDS.filter(field => field !== 'settings').toSorted());
  });
});

describe('materializing a private copy', () => {
  it('should file a private copy under the account wrapper, keeping the document name', () => {
    // Act / Assert — the wrapper is unique across the fleet by schema, so two accounts unlinking one
    // document cannot compose the same destination and silently share the copy each asked to own.
    should(accountAssetPath('claude-one', './CLAUDE.md')).equal('accounts/claude-one/CLAUDE.md');
    should(accountAssetPath('codex-two', 'memory/nested/AGENTS.md')).equal('accounts/codex-two/AGENTS.md');
  });

  it('should fall back to the whole reference when it has no path segments at all', () => {
    // Act / Assert — a reference of nothing but separators has no last segment; the copy is still named
    // rather than landing at a directory path.
    should(accountAssetPath('claude-one', '/')).equal('accounts/claude-one//');
  });

  it('should refuse a directory field with the remedy rather than half-copying it', () => {
    // Assert — the two directory fields are refused and the four file fields are not, read from the
    // shape table so a newly added field cannot silently become copyable.
    for (const field of ASSET_FIELDS) {
      const reason = unlinkableReason(field);
      if (ASSET_FIELD_SHAPES[field] === 'directory') should(reason).match(/names a directory/u);
      else should(reason).be.undefined();
    }
  });

  it('should refuse a source outside the asset tree, naming which one it is', () => {
    // Act / Assert
    should(unreadableSourceReason('./CLAUDE.md')).be.undefined();
    should(unreadableSourceReason('memory/CLAUDE.md')).be.undefined();
    should(unreadableSourceReason('/etc/instructions.md')).match(/outside this fleet's asset tree/u);
    should(unreadableSourceReason('~/notes.md')).match(/outside this fleet's asset tree/u);
    should(unreadableSourceReason('$HOME/notes.md')).match(/outside this fleet's asset tree/u);
  });
});
