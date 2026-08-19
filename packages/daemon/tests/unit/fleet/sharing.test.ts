/**
 * The daemon half of shared assets: the wire projection, and what a link or unlink derives.
 *
 * The two mutations are exercised through `applyFleetMutation` rather than through the internal
 * helpers, because what matters is that a named intent produces a configuration whose *resolved*
 * sharing is the one asked for — which is exactly what the derivation asserts before it returns.
 */
import { describe, it } from 'bun:test';
import { type FleetConfig, FleetConfigSchema, LINKABLE_FIELDS, resolveFleetSharing } from '@ferretry/fleet';
import { FLEET_LINKABLE_FIELDS, FleetSharingSchema } from '@ferretry/protocol';
import should from 'should';
import {
  applyFleetMutation,
  type FleetMutation,
  FleetMutationRefusal,
  FleetMutationSchema,
} from '../../../src/lib/fleet/mutations.ts';
import { planSharedAssetUnlink, sharingSummary } from '../../../src/lib/fleet/sharing.ts';

const ID_ONE = '00000000-0000-4000-8000-0000000000b1';
const ID_TWO = '00000000-0000-4000-8000-0000000000b2';
const ID_ABSENT = '00000000-0000-4000-8000-0000000000bf';

const mintId = (): string => ID_ABSENT;

const configOf = (input: Record<string, unknown>): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse({ variants: { default: {} }, ...input });
  if (!parsed.success) throw new Error(`fixture is not valid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
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

/** One Claude account and one Codex account, both on a declared shared memory document. */
const sharedFleet = (claudeOverrides: Record<string, unknown> = {}): FleetConfig =>
  configOf({
    shared: { memory: { default: './CLAUDE.md', terse: './terse.md' }, skills: { default: './skills' } },
    profiles: { base: { memory: './CLAUDE.md' } },
    agents: [
      { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one', claudeOverrides) } },
      { name: 'two', kind: 'codex', routes: { default: route(ID_TWO, 'codex-two') } },
    ],
  });

const mutationOf = (input: Record<string, unknown>): FleetMutation => {
  const parsed = FleetMutationSchema.safeParse(input);
  if (!parsed.success) throw new Error(`mutation is not valid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data;
};

const refusalOf = (act: () => unknown): string => {
  try {
    act();
  } catch (error) {
    should(error).be.instanceof(FleetMutationRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

const sharingOf = (config: FleetConfig, accountId: string) =>
  resolveFleetSharing(config).accounts.find(account => account.accountId === accountId);

describe('the sharing wire projection', () => {
  it('should project the whole report through the shared schema', () => {
    // Arrange — one shared field, one inline settings layer, one shared settings document, one own copy.
    const config = configOf({
      shared: { memory: { default: './CLAUDE.md' }, settings: { base: './base.json' } },
      profiles: { base: { memory: './CLAUDE.md', settings: ['./base.json', { model: 'opus' }] } },
      agents: [
        { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } },
        {
          name: 'two',
          kind: 'claude',
          routes: { default: route(ID_TWO, 'claude-two', { layer: { memory: './own.md' } }) },
        },
      ],
    });

    // Act — parsed on the way out, exactly as the route does it, so a projection the browser could not
    // render fails here rather than at a client.
    const summary = FleetSharingSchema.parse(sharingSummary(resolveFleetSharing(config)));

    // Assert
    should(summary.documents).deepEqual([
      { field: 'settings', name: 'base', path: './base.json', accounts: [ID_ONE, ID_TWO] },
      { field: 'memory', name: 'default', path: './CLAUDE.md', accounts: [ID_ONE] },
    ]);
    should(summary.accounts[0]?.fields.memory).deepEqual({
      state: 'shared',
      name: 'default',
      path: './CLAUDE.md',
      origin: { kind: 'base-profile', name: 'base' },
      referrers: 1,
    });
    should(summary.accounts[1]?.fields.memory).deepEqual({
      state: 'local',
      path: './own.md',
      origin: { kind: 'account' },
      referrers: 1,
    });
    should(summary.accounts[0]?.fields.skills).deepEqual({ state: 'absent' });
    should(summary.accounts[0]?.settings).deepEqual([
      {
        position: 0,
        kind: 'document',
        path: './base.json',
        name: 'base',
        origin: { kind: 'base-profile', name: 'base' },
        referrers: 2,
      },
      { position: 1, kind: 'inline', origin: { kind: 'base-profile', name: 'base' } },
    ]);
  });

  it('should omit the shared name of a settings layer that has none, rather than sending a null', () => {
    // Arrange
    const config = configOf({
      profiles: { base: { settings: './undeclared.json' } },
      agents: [{ name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } }],
    });

    // Act
    const summary = FleetSharingSchema.parse(sharingSummary(resolveFleetSharing(config)));

    // Assert — the wire shape has no null branch, so an absent name must be a missing key.
    should(summary.accounts[0]?.settings[0]).deepEqual({
      position: 0,
      kind: 'document',
      path: './undeclared.json',
      origin: { kind: 'base-profile', name: 'base' },
      referrers: 1,
    });
  });

  it('should describe the same linkable fields the wire enumerates', () => {
    // Assert — the browser cannot import the fleet package, so the two lists are separate declarations
    // of one closed set. Nothing else in the repository compares them.
    should([...LINKABLE_FIELDS].toSorted()).deepEqual([...FLEET_LINKABLE_FIELDS].toSorted());
  });
});

describe('linking an account to a shared document', () => {
  it('should point the account at the declared document and report it as shared', () => {
    // Arrange — the account starts on its own copy.
    const config = sharedFleet({ layer: { memory: './accounts/claude-one/CLAUDE.md' } });
    should(sharingOf(config, ID_ONE)?.fields.memory).match({ state: 'local' });

    // Act
    const next = applyFleetMutation(
      config,
      mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'memory', name: 'terse' }),
      mintId,
    );

    // Assert — the shared document is what the account now resolves to, and every other account is
    // untouched.
    should(sharingOf(next, ID_ONE)?.fields.memory).match({ state: 'shared', name: 'terse', path: './terse.md' });
    should(sharingOf(next, ID_TWO)?.fields.memory).match({ state: 'shared', name: 'default' });
  });

  it('should clear the per-harness overlay that would otherwise keep winning', () => {
    // Arrange — an overlay is applied after the slot's flat fields, so setting the flat field alone
    // would report success and change nothing.
    const config = sharedFleet({ layer: { claude: { memory: './accounts/claude-one/CLAUDE.md' } } });

    // Act
    const next = applyFleetMutation(
      config,
      mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'memory', name: 'terse' }),
      mintId,
    );

    // Assert — and the emptied overlay is dropped rather than left as `claude: {}`.
    should(sharingOf(next, ID_ONE)?.fields.memory).match({ state: 'shared', name: 'terse' });
    const layer = next.agents[0]?.routes.default?.layer;
    should(layer?.memory).equal('./terse.md');
    should(layer).not.have.property('claude');
  });

  it('should keep the rest of a harness overlay when it clears one field from it', () => {
    // Arrange
    const config = sharedFleet({ layer: { claude: { memory: './own.md', mcp: './own.json' } } });

    // Act
    const next = applyFleetMutation(
      config,
      mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'memory', name: 'terse' }),
      mintId,
    );

    // Assert — clearing the field it is replacing must not take the account's MCP list with it.
    should(next.agents[0]?.routes.default?.layer?.claude).deepEqual({ mcp: './own.json' });
    should(sharingOf(next, ID_ONE)?.fields.mcp).match({ state: 'local', path: './own.json' });
  });

  it('should preserve every other field of an account overlay it edits', () => {
    // Arrange
    const config = sharedFleet({ layer: { memory: './own.md', flags: ['--keep'], env: { A: '1' } } });

    // Act
    const next = applyFleetMutation(
      config,
      mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'memory', name: 'default' }),
      mintId,
    );

    // Assert
    should(next.agents[0]?.routes.default?.layer).deepEqual({
      memory: './CLAUDE.md',
      flags: ['--keep'],
      env: { A: '1' },
    });
  });

  it('should never change an account identity while linking', () => {
    // Arrange
    const config = sharedFleet();

    // Act
    const next = applyFleetMutation(
      config,
      mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'memory', name: 'terse' }),
      mintId,
    );

    // Assert — the id, wrapper and home are what every consumer joins on.
    should(next.agents[0]?.routes.default).match({ id: ID_ONE, wrapper: 'claude-one', home: 'claude-one' });
  });

  it('should refuse a name this fleet does not declare, listing the ones it does', () => {
    // Act / Assert
    should(
      refusalOf(() =>
        applyFleetMutation(
          sharedFleet(),
          mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'memory', name: 'nope' }),
          mintId,
        ),
      ),
    ).match(/no shared "memory" document named "nope"; it has "default", "terse"/u);
  });

  it('should refuse a field with no declared documents by naming where to declare one', () => {
    // Act / Assert
    should(
      refusalOf(() =>
        applyFleetMutation(
          sharedFleet(),
          mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'mcp', name: 'default' }),
          mintId,
        ),
      ),
    ).match(/declares no shared "mcp" document; declare one under shared\.mcp first/u);
  });

  it('should refuse a field the account harness has no destination for', () => {
    // Act / Assert — Codex has no MCP destination, so this would otherwise be refused later by the plan
    // builder, naming an unsupported asset rather than the control the person clicked.
    should(
      refusalOf(() =>
        applyFleetMutation(
          sharedFleet(),
          mutationOf({ kind: 'link-shared-asset', accountId: ID_TWO, field: 'mcp', name: 'default' }),
          mintId,
        ),
      ),
    ).match(/the codex harness has no destination for "mcp", so codex-two cannot link one/u);
  });

  it('should refuse an account this fleet does not declare', () => {
    // Act / Assert
    should(
      refusalOf(() =>
        applyFleetMutation(
          sharedFleet(),
          mutationOf({ kind: 'link-shared-asset', accountId: ID_ABSENT, field: 'memory', name: 'default' }),
          mintId,
        ),
      ),
    ).match(/declares no account with id/u);
  });
});

describe('giving an account its own copy', () => {
  it('should name the source, the destination and the document being left', () => {
    // Act
    const unlink = planSharedAssetUnlink(sharedFleet(), ID_ONE, 'memory');

    // Assert — the destination is derived from the wrapper, which the schema proves unique, and the
    // source is canonical: the asset editor's grammar refuses a `.` segment, so the declared
    // `./CLAUDE.md` could not be read as written.
    should(unlink).deepEqual({
      field: 'memory',
      source: 'CLAUDE.md',
      destination: 'accounts/claude-one/CLAUDE.md',
      name: 'default',
      wrapper: 'claude-one',
    });
  });

  it('should point the account at its own copy and report it as local', () => {
    // Act
    const next = applyFleetMutation(
      sharedFleet(),
      mutationOf({ kind: 'unlink-shared-asset', accountId: ID_ONE, field: 'memory' }),
      mintId,
    );

    // Assert — and the account that stayed shared is untouched, which is the whole point of a copy.
    should(sharingOf(next, ID_ONE)?.fields.memory).match({
      state: 'local',
      path: 'accounts/claude-one/CLAUDE.md',
      origin: { kind: 'account' },
    });
    should(sharingOf(next, ID_TWO)?.fields.memory).match({ state: 'shared', name: 'default' });
  });

  it('should leave the shared document declared and still used by everybody else', () => {
    // Act
    const next = applyFleetMutation(
      sharedFleet(),
      mutationOf({ kind: 'unlink-shared-asset', accountId: ID_ONE, field: 'memory' }),
      mintId,
    );

    // Assert
    should(next.shared.memory).deepEqual({ default: './CLAUDE.md', terse: './terse.md' });
    should(resolveFleetSharing(next).documents).containEql({
      field: 'memory',
      name: 'default',
      path: './CLAUDE.md',
      accounts: [ID_TWO],
    });
  });

  it('should refuse a field that declares nothing at all', () => {
    // Act / Assert — there is nothing to copy, and pointing the account at an empty path would be the
    // "left with nothing" outcome this operation exists to avoid.
    should(refusalOf(() => planSharedAssetUnlink(sharedFleet(), ID_ONE, 'skills'))).match(
      /declares no "skills", so there is nothing to unlink/u,
    );
  });

  it('should refuse a field that already holds the account own path', () => {
    // Act / Assert
    should(
      refusalOf(() => planSharedAssetUnlink(sharedFleet({ layer: { memory: './own.md' } }), ID_ONE, 'memory')),
    ).match(/already uses its own "memory" at "\.\/own\.md"/u);
  });

  it('should refuse a per-item selection because no single document is being left', () => {
    // Arrange
    const config = configOf({
      shared: { skills: { default: './skills/review' } },
      profiles: { base: { skills: ['./skills/review'] } },
      agents: [{ name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } }],
    });

    // Act / Assert — reached before the directory refusal below, and the better sentence of the two:
    // an item is dropped from the list, never copied to a path this account then owns privately.
    should(refusalOf(() => planSharedAssetUnlink(config, ID_ONE, 'skills'))).match(
      /"skills" holds a per-item selection rather than one document/u,
    );
  });

  it('should refuse a directory field with the manual remedy', () => {
    // Arrange — hooksDir is the remaining directory-shaped field, and Codex is the harness that has a
    // destination for it.
    const config = configOf({
      shared: { hooksDir: { default: './hooks' } },
      profiles: { base: { hooksDir: './hooks' } },
      agents: [{ name: 'two', kind: 'codex', routes: { default: route(ID_TWO, 'codex-two') } }],
    });

    // Act / Assert
    should(refusalOf(() => planSharedAssetUnlink(config, ID_TWO, 'hooksDir'))).match(
      /names a directory, and a private copy of a directory is not something the reviewed asset editor can write/u,
    );
  });

  it('should refuse a shared document that lives outside the asset tree', () => {
    // Arrange — an operator may legitimately declare an absolute path by hand.
    const config = configOf({
      shared: { memory: { default: '/etc/instructions.md' } },
      profiles: { base: { memory: '/etc/instructions.md' } },
      agents: [{ name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } }],
    });

    // Act / Assert
    should(refusalOf(() => planSharedAssetUnlink(config, ID_ONE, 'memory'))).match(
      /outside this fleet's asset tree, so its text cannot be read here/u,
    );
  });

  it('should refuse a destination the registry has already promised to everybody', () => {
    // Arrange — the copy's destination is derived from the wrapper, and here the fleet has declared that
    // exact path as a shared document. The file need not exist yet, so nothing later would catch it.
    const config = configOf({
      shared: {
        memory: { default: './CLAUDE.md', trap: 'accounts/claude-one/CLAUDE.md' },
      },
      profiles: { base: { memory: './CLAUDE.md' } },
      agents: [{ name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one') } }],
    });

    // Act / Assert — seeding it would make one account's private copy what every account linking "trap"
    // receives, which is the exact inversion of the request.
    should(refusalOf(() => planSharedAssetUnlink(config, ID_ONE, 'memory'))).match(
      /which this fleet declares as the shared "trap" memory document/u,
    );
  });

  it('should refuse an account this fleet does not declare', () => {
    // Act / Assert
    should(refusalOf(() => planSharedAssetUnlink(sharedFleet(), ID_ABSENT, 'memory'))).match(
      /declares no account with id/u,
    );
  });
});

describe('projecting a per-item selection onto the wire', () => {
  const storeFleet = (): FleetConfig =>
    configOf({
      shared: { skills: { review: './skills/review' } },
      agents: [
        {
          name: 'one',
          kind: 'claude',
          routes: {
            default: route(ID_ONE, 'claude-one', { layer: { skills: ['./skills/review', './skills/mine'] } }),
          },
        },
        {
          name: 'two',
          kind: 'claude',
          routes: { default: route(ID_TWO, 'claude-two', { layer: { skills: ['./skills/review'] } }) },
        },
      ],
    });

  it('should carry every item, its store name, and how many accounts are on it', () => {
    // Act — parsed on the way out exactly as the route does it.
    const summary = FleetSharingSchema.parse(sharingSummary(resolveFleetSharing(storeFleet())));

    // Assert — the second item is this account's own, so it carries no shared name at all rather than a
    // null the wire shape has no branch for.
    should(summary.accounts[0]?.fields.skills).deepEqual({
      state: 'selection',
      origin: { kind: 'account' },
      items: [
        { name: 'review', path: './skills/review', sharedName: 'review', referrers: 2 },
        { name: 'mine', path: './skills/mine', referrers: 1 },
      ],
    });
  });

  it('should carry a selection of nothing as an empty list rather than as absent', () => {
    // Arrange
    const config = configOf({
      agents: [
        { name: 'one', kind: 'claude', routes: { default: route(ID_ONE, 'claude-one', { layer: { skills: [] } }) } },
      ],
    });

    // Act
    const summary = FleetSharingSchema.parse(sharingSummary(resolveFleetSharing(config)));

    // Assert
    should(summary.accounts[0]?.fields.skills).deepEqual({
      state: 'selection',
      origin: { kind: 'account' },
      items: [],
    });
  });
});
