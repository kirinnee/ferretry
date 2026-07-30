import { describe, it } from 'bun:test';
import should from 'should';
import { FleetConfigSchema } from '../../src/lib/config.ts';
import type { FleetConfig } from '../../src/lib/config.ts';
import {
  WrapperCollisionError,
  expandAliases,
  groupByIdentity,
  resolveAccounts,
  resolveCommands,
  toManifestAccounts,
} from '../../src/lib/profiles.ts';
import { FleetManifestAccountSchema } from '../../src/lib/manifest.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';
const ID_THREE = '00000000-0000-4000-8000-000000000003';

/** Parse rather than hand-build, so every test runs against configuration a user could write. */
const parse = (input: Record<string, unknown>): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`fixture is not valid configuration: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  return parsed.data;
};

const route = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID_ONE,
  wrapper: 'claude-kirin',
  home: '/homes/claude-kirin',
  defaultModel: 'model-one',
  models: ['model-one'],
  ...overrides,
});

describe('resolveAccounts', () => {
  it('should apply layers in source precedence order, merging env and concatenating flags', () => {
    // Arrange
    const config = parse({
      profiles: {
        base: { env: { A: '1' }, flags: ['--base'] },
        first: { env: { B: '2' }, flags: ['--first'] },
        second: { env: { A: '9' }, flags: ['--second'] },
        lane: { env: { C: '3' }, flags: ['--lane'] },
      },
      variants: { default: { profiles: ['lane'], flags: ['--variant-inline'], env: { D: '4' } } },
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          profiles: ['first', 'second'],
          flags: ['--agent-inline'],
          env: { A: 'agent-wins', E: '5' },
          routes: { default: route() },
        },
      ],
    });
    const expectedFlags = ['--base', '--first', '--second', '--lane', '--variant-inline', '--agent-inline'];

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual.length).equal(1);
    should(actual[0]?.flags).deepEqual(expectedFlags);
    should(actual[0]?.env).deepEqual({ A: 'agent-wins', B: '2', C: '3', D: '4', E: '5' });
  });

  it('should concatenate settings layers across every slot instead of replacing them', () => {
    // Arrange
    const config = parse({
      profiles: { base: { settings: './base.json' }, extra: { settings: [{ theme: 'dark' }] } },
      variants: { default: { settings: { lane: 'default' } } },
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          profiles: ['extra'],
          settings: { last: true },
          routes: { default: route() },
        },
      ],
    });
    const expected = ['./base.json', { theme: 'dark' }, { lane: 'default' }, { last: true }];

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual[0]?.settings).deepEqual(expected);
  });

  it('should let a later slot scalar replace an earlier one', () => {
    // Arrange
    const config = parse({
      profiles: { base: { memory: './base.md' } },
      variants: { default: { memory: './variant.md' } },
      agents: [{ name: 'kirin', kind: 'claude', memory: './agent.md', routes: { default: route() } }],
    });

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual[0]?.memory).equal('./agent.md');
  });

  it('should apply a harness overlay only to its own harness and drop the overlay blocks', () => {
    // Arrange
    const config = parse({
      variants: { default: { codex: { flags: ['--codex-only'] } } },
      agents: [
        { name: 'kirin', kind: 'claude', routes: { default: route() } },
        {
          name: 'loge',
          kind: 'codex',
          routes: { default: route({ id: ID_TWO, wrapper: 'codex-loge', home: '/homes/codex-loge' }) },
        },
      ],
    });

    // Act
    const actual = resolveAccounts(config);
    const claude = actual.find(entry => entry.kind === 'claude');
    const codex = actual.find(entry => entry.kind === 'codex');

    // Assert
    should(claude?.flags).deepEqual([]);
    should(codex?.flags).deepEqual(['--codex-only']);
    should((codex as unknown as Record<string, unknown>).codex).be.undefined();
  });

  it('should let a later slot flat field beat an earlier slot harness overlay', () => {
    // Arrange
    const config = parse({
      profiles: { p: { codex: { memory: './from-overlay.md' } } },
      agents: [
        {
          name: 'loge',
          kind: 'codex',
          profiles: ['p'],
          memory: './from-inline.md',
          routes: { default: route({ wrapper: 'codex-loge', home: '/homes/codex-loge' }) },
        },
      ],
    });

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual[0]?.memory).equal('./from-inline.md');
  });

  it('should let an overlay win inside its own slot', () => {
    // Arrange
    const config = parse({
      agents: [
        {
          name: 'loge',
          kind: 'codex',
          memory: './flat.md',
          codex: { memory: './overlay.md' },
          routes: { default: route({ wrapper: 'codex-loge', home: '/homes/codex-loge' }) },
        },
      ],
    });

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual[0]?.memory).equal('./overlay.md');
  });

  it('should produce one account per declared route and no others', () => {
    // Arrange — the auto lane exists, but this agent opted only into default
    const config = parse({
      variants: { default: {}, auto: { mode: 'auto' } },
      agents: [
        { name: 'kirin', kind: 'claude', routes: { default: route() } },
        {
          name: 'atomi',
          kind: 'claude',
          routes: {
            default: route({ id: ID_TWO, wrapper: 'claude-atomi', home: '/homes/atomi' }),
            auto: route({ id: ID_THREE, wrapper: 'claude-auto-atomi', home: '/homes/auto-atomi' }),
          },
        },
      ],
    });

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual.map(entry => entry.wrapper)).deepEqual(['claude-kirin', 'claude-atomi', 'claude-auto-atomi']);
  });

  it('should take mode from the route, then the variant, and never from a name', () => {
    // Arrange — "auto-target" is a default-lane account despite how its name reads
    const config = parse({
      variants: { default: {}, auto: { mode: 'auto' } },
      agents: [
        { name: 'auto-target', kind: 'claude', routes: { default: route({ wrapper: 'claude-auto-target' }) } },
        {
          name: 'atomi',
          kind: 'claude',
          routes: {
            auto: route({ id: ID_TWO, wrapper: 'claude-atomi', home: '/homes/atomi' }),
            default: route({ id: ID_THREE, wrapper: 'plain-atomi', home: '/homes/plain', mode: 'auto' }),
          },
        },
      ],
    });

    // Act
    const actual = resolveAccounts(config);
    const byWrapper = new Map(actual.map(entry => [entry.wrapper, entry]));

    // Assert
    should(byWrapper.get('claude-auto-target')?.mode).equal('interactive');
    should(byWrapper.get('claude-atomi')?.mode).equal('auto');
    should(byWrapper.get('plain-atomi')?.mode).equal('auto');
  });

  it('should keep the account id stable when every other attribute is renamed', () => {
    // Arrange — the id is the only join key, so renaming attributes must not disturb it
    const before = parse({
      agents: [{ name: 'kirin', kind: 'claude', routes: { default: route() } }],
    });
    const after = parse({
      agents: [
        {
          name: 'kirin-renamed',
          kind: 'claude',
          routes: {
            default: route({
              wrapper: 'crc-something-else',
              home: '/homes/relocated',
              displayName: 'Renamed Everything',
            }),
          },
        },
      ],
    });

    // Act
    const first = resolveAccounts(before)[0];
    const second = resolveAccounts(after)[0];

    // Assert
    should(second?.id).equal(first?.id as string);
    should(second?.wrapper).not.equal(first?.wrapper as string);
    should(second?.home).not.equal(first?.home as string);
    should(second?.displayName).not.equal(first?.displayName as string);
  });

  it('should default displayName to the wrapper and identity to the agent name', () => {
    // Arrange
    const config = parse({
      agents: [
        { name: 'kirin', kind: 'claude', routes: { default: route() } },
        {
          name: 'f5-kirin',
          kind: 'claude',
          identity: 'kirin',
          routes: { default: route({ id: ID_TWO, wrapper: 'claude-f5-kirin', home: '/homes/f5' }) },
        },
      ],
    });

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual[0]?.displayName).equal('claude-kirin');
    should(actual[0]?.identity).equal('kirin');
    should(actual[1]?.identity).equal('kirin');
  });

  it('should carry declared availability onto the resolved account', () => {
    // Arrange
    const config = parse({
      agents: [
        {
          name: 'loge',
          kind: 'claude',
          routes: {
            default: route({
              available: false,
              unavailableReason: 'every credential returns 429',
              defaultModel: undefined,
              models: [{ id: 'model-down', available: false, unavailableReason: 'pool exhausted' }],
            }),
          },
        },
      ],
    });

    // Act
    const actual = resolveAccounts(config);

    // Assert
    should(actual[0]?.available).be.false();
    should(actual[0]?.unavailableReason).equal('every credential returns 429');
    should(actual[0]?.defaultModel).be.null();
  });
});

describe('groupByIdentity', () => {
  it('should pool every account that shares one provider login', () => {
    // Arrange
    const config = parse({
      variants: { default: {}, auto: { mode: 'auto' } },
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          routes: {
            default: route(),
            auto: route({ id: ID_TWO, wrapper: 'claude-auto-kirin', home: '/homes/auto-kirin' }),
          },
        },
        {
          name: 'loge',
          kind: 'codex',
          routes: { default: route({ id: ID_THREE, wrapper: 'codex-loge', home: '/homes/codex-loge' }) },
        },
      ],
    });

    // Act
    const actual = groupByIdentity(resolveAccounts(config));

    // Assert
    should([...actual.keys()].sort()).deepEqual(['claude:kirin', 'codex:loge']);
    should(actual.get('claude:kirin')?.map(entry => entry.wrapper)).deepEqual(['claude-kirin', 'claude-auto-kirin']);
  });
});

describe('expandAliases and resolveCommands', () => {
  const twoHarnesses = (aliases: Record<string, unknown>): FleetConfig =>
    parse({
      aliases,
      agents: [
        { name: 'atomi', kind: 'claude', routes: { default: route({ wrapper: 'claude-atomi' }) } },
        {
          name: 'loge',
          kind: 'codex',
          routes: { default: route({ id: ID_TWO, wrapper: 'codex-loge', home: '/homes/codex-loge' }) },
        },
      ],
    });

  it('should fan an alias out only to the harnesses it lists, targeting accounts by id', () => {
    // Arrange
    const config = twoHarnesses({ crc: { claude: '--dangerously-skip-permissions --chrome --rc' } });
    const accounts = resolveAccounts(config);

    // Act
    const actual = expandAliases(config, accounts);

    // Assert
    should(actual.length).equal(1);
    should(actual[0]?.wrapper).equal('crc-claude-atomi');
    should(actual[0]?.target).equal(ID_ONE);
    should(actual[0]?.flags).deepEqual(['--dangerously-skip-permissions', '--chrome', '--rc']);
  });

  it('should accept alias flags as a list as well as a whitespace string', () => {
    // Arrange
    const config = twoHarnesses({ yolo: { codex: ['--full-auto'] } });

    // Act
    const actual = expandAliases(config, resolveAccounts(config));

    // Assert
    should(actual[0]?.wrapper).equal('yolo-codex-loge');
    should(actual[0]?.flags).deepEqual(['--full-auto']);
  });

  it('should fan one alias across both harnesses without colliding on a shared account name', () => {
    // Arrange — the same account name under two harnesses is exactly what used to collide
    const config = parse({
      aliases: { crc: { claude: '--chrome', codex: '--full-auto' } },
      agents: [
        { name: 'loge', kind: 'claude', routes: { default: route({ wrapper: 'claude-loge' }) } },
        {
          name: 'loge',
          kind: 'codex',
          routes: { default: route({ id: ID_TWO, wrapper: 'codex-loge', home: '/homes/codex-loge' }) },
        },
      ],
    });

    // Act
    const actual = resolveCommands(config, resolveAccounts(config));

    // Assert
    should(actual.map(entry => entry.wrapper).sort()).deepEqual(['crc-claude-loge', 'crc-codex-loge']);
  });

  it('should report a collision when two aliases compose to the same name', () => {
    // Arrange — alias "a-b" over wrapper "c" and alias "a" over wrapper "b-c" both make "a-b-c"
    const config = parse({
      aliases: { 'a-b': { claude: '--x' }, a: { claude: '--y' } },
      agents: [
        { name: 'c', kind: 'claude', routes: { default: route({ wrapper: 'c' }) } },
        {
          name: 'b-c',
          kind: 'claude',
          routes: { default: route({ id: ID_TWO, wrapper: 'b-c', home: '/homes/b-c' }) },
        },
      ],
    });
    const accounts = resolveAccounts(config);

    // Act + Assert
    should(() => resolveCommands(config, accounts)).throw(WrapperCollisionError);
    should(() => resolveCommands(config, accounts)).throw(/a-b-c/);
  });

  it('should report a collision between an alias and an account wrapper', () => {
    // Arrange
    const config = parse({
      aliases: { crc: { claude: '--x' } },
      agents: [
        { name: 'atomi', kind: 'claude', routes: { default: route({ wrapper: 'atomi' }) } },
        {
          name: 'other',
          kind: 'claude',
          routes: { default: route({ id: ID_TWO, wrapper: 'crc-atomi', home: '/homes/other' }) },
        },
      ],
    });
    const accounts = resolveAccounts(config);

    // Act + Assert
    should(() => resolveCommands(config, accounts)).throw(/crc-atomi/);
  });

  it('should list explicit commands before the alias fan-out', () => {
    // Arrange
    const config = parse({
      aliases: { crc: { claude: '--chrome' } },
      commands: [{ wrapper: 'yolo-atomi', target: ID_ONE, flags: ['--dangerous'] }],
      agents: [{ name: 'atomi', kind: 'claude', routes: { default: route({ wrapper: 'claude-atomi' }) } }],
    });

    // Act
    const actual = resolveCommands(config, resolveAccounts(config));

    // Assert
    should(actual.map(entry => entry.wrapper)).deepEqual(['yolo-atomi', 'crc-claude-atomi']);
    should(actual[0]?.alias).be.undefined();
    should(actual[1]?.alias).equal('crc');
  });
});

describe('toManifestAccounts', () => {
  it('should publish the wrapper as a full path under the bin directory', () => {
    // Arrange
    const config = parse({ agents: [{ name: 'kirin', kind: 'claude', routes: { default: route() } }] });

    // Act
    const actual = toManifestAccounts(resolveAccounts(config), '/state/fleet/bin');

    // Assert
    should(actual[0]?.wrapper).equal('/state/fleet/bin/claude-kirin');
    should(actual[0]?.home).equal('/homes/claude-kirin');
  });

  it('should not double a separator when the bin directory already ends in one', () => {
    // Arrange
    const config = parse({ agents: [{ name: 'kirin', kind: 'claude', routes: { default: route() } }] });

    // Act
    const actual = toManifestAccounts(resolveAccounts(config), '/state/fleet/bin/');

    // Assert
    should(actual[0]?.wrapper).equal('/state/fleet/bin/claude-kirin');
  });

  it('should produce accounts the manifest schema accepts', () => {
    // Arrange
    const config = parse({
      variants: { default: {}, auto: { mode: 'auto' } },
      agents: [
        {
          name: 'atomi',
          kind: 'claude',
          routes: {
            default: route({ models: ['model-one', { id: 'model-down', available: false, unavailableReason: 'q' }] }),
            auto: route({ id: ID_TWO, wrapper: 'claude-auto-atomi', home: '/homes/auto-atomi' }),
          },
        },
      ],
    });

    // Act
    const actual = toManifestAccounts(resolveAccounts(config), '/state/fleet/bin');

    // Assert
    should(actual.length).equal(2);
    for (const account of actual) {
      should(FleetManifestAccountSchema.safeParse(account).success).be.true();
    }
  });
});
