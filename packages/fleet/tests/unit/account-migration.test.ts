import { describe, it } from 'bun:test';
import should from 'should';
import {
  approvedPlanOf,
  everyCopyIsSeeded,
  freshestCopy,
  MigrationApprovedPlanSchema,
  type MigrationHomeReading,
  type MigrationPlan,
  type MigrationSurvey,
  planMigration,
  renderMigrationDryRun,
} from '../../src/lib/account/migration.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold, fleetScaffoldIds } from '../../src/lib/scaffold.ts';
import type { FleetSeedProvenanceRecord } from '../../src/lib/seed-provenance.ts';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/someone',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/someone/.claude', codex: '/home/someone/.codex' },
};

/** Today's real first run, ids 0–3: claude-default, claude-auto-default, codex-default, codex-auto-default. */
const firstRunDocument = (): unknown => {
  let next = 0;
  const scaffold = buildFleetScaffold({
    layout: LAYOUT,
    ids: fleetScaffoldIds(() => id(next++)),
    configPath: '/fy/fleet/config.yaml',
    firstAccounts: ['claude', 'codex'],
  });
  return Bun.YAML.parse(scaffold.files[0]?.content ?? '');
};

const routeIdsOf = (document: unknown): Record<string, string> => {
  const agents = (document as { agents: { routes: Record<string, { id: string; wrapper: string }> }[] }).agents;
  return Object.fromEntries(
    agents.flatMap(agent => Object.values(agent.routes).map(route => [route.wrapper, route.id] as const)),
  );
};

const homeReading = (
  accountId: string,
  harness: HarnessKind,
  home: string,
  overrides: Partial<MigrationHomeReading> = {},
): MigrationHomeReading => ({
  accountId,
  harness,
  home,
  state: 'valid',
  freshness: 1_000,
  fingerprint: 'same',
  copies: [{ kind: 'file', path: `${home}/${harness === 'claude' ? '.credentials.json' : 'auth.json'}` }],
  ...overrides,
});

const record = (accountId: string, kind: HarnessKind, fingerprint = 'same'): FleetSeedProvenanceRecord => ({
  accountId,
  kind,
  seededFrom: `host:${kind}`,
  donorHome: `/home/someone/.${kind}`,
  seedFingerprint: fingerprint,
  seededAt: 1,
});

/** A first-run survey: every home a copy with digest `same`, the host signed in with the same login. */
const firstRunSurvey = (overrides: Partial<MigrationSurvey> = {}): MigrationSurvey => {
  const document = firstRunDocument();
  const routes = routeIdsOf(document);
  const homes = Object.entries(routes).map(([wrapper, route]) =>
    homeReading(route, wrapper.startsWith('claude') ? 'claude' : 'codex', `/fy/fleet/homes/${wrapper}`),
  );
  return {
    document,
    layout: LAYOUT,
    homes,
    host: {
      claude: { harness: 'claude', directory: '/home/someone/.claude', state: 'valid', fingerprint: 'same' },
      codex: { harness: 'codex', directory: '/home/someone/.codex', state: 'valid', fingerprint: 'same' },
    },
    provenance: homes.map(home => record(home.accountId, home.harness)),
    liveSessions: [],
    mcpFiles: {},
    keychain: false,
    ...overrides,
  };
};

const route = (n: number, wrapper: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(n),
  wrapper,
  home: wrapper,
  defaultModel: 'model-one',
  models: ['model-one'],
  ...overrides,
});

const survey = (document: unknown, overrides: Partial<MigrationSurvey> = {}): MigrationSurvey => ({
  document,
  layout: LAYOUT,
  homes: [],
  host: {},
  provenance: [],
  liveSessions: [],
  mcpFiles: {},
  keychain: false,
  ...overrides,
});

const decision = (plan: MigrationPlan, credential: string) => plan.credentials.find(item => item.id === credential);

describe('planMigration — the default first run', () => {
  it('should share the terminal login and retire every seeded copy', () => {
    // Act
    const plan = planMigration(firstRunSurvey());

    // Assert
    should(plan.model.credentials).deepEqual({
      'claude-default': { harness: 'claude', store: 'host' },
      'codex-default': { harness: 'codex', store: 'host' },
    });
    const claude = decision(plan, 'claude-default');
    should(claude?.source).deepEqual({
      kind: 'host',
      directory: '/home/someone/.claude',
      signedIn: true,
      reason:
        'every copy is still the unchanged copy taken from your own claude login, so Ferretry shares that login instead of keeping copies',
    });
    should(claude?.retire.map(item => item.wrapper)).deepEqual(['claude-default', 'claude-auto-default']);
    should(claude?.link).deepEqual([]);
    should(decision(plan, 'codex-default')?.link).deepEqual([
      '/fy/fleet/homes/codex-default',
      '/fy/fleet/homes/codex-auto-default',
    ]);
    should(plan.blockers).deepEqual([]);
  });

  it('should keep every route UUID and config directory, so every old join still holds', () => {
    // Act
    const plan = planMigration(firstRunSurvey());

    // Assert
    should(plan.ids.runtimes['claude-auto-default']).deepEqual({
      id: id(1),
      formerNames: [],
      home: 'claude-auto-default',
    });
    should(plan.runtimes.find(runtime => runtime.name === 'codex-default')).deepEqual({
      name: 'codex-default',
      id: id(2),
      wrapper: 'codex-default',
      credential: 'codex-default',
      agent: false,
      home: '/fy/fleet/homes/codex-default',
    });
    should(plan.historyPooled).deepEqual(['claude', 'codex']);
  });

  it('should give the same machine the same digest, and a changed machine another', () => {
    // Act
    const first = planMigration(firstRunSurvey());
    const again = planMigration(firstRunSurvey());
    const changed = planMigration(firstRunSurvey({ provenance: [] }));

    // Assert
    should(again.digest).equal(first.digest);
    should(changed.digest).not.equal(first.digest);
  });

  it('should round-trip the approved part through the schema the executor saves it with', () => {
    // Arrange
    const approved = approvedPlanOf(planMigration(firstRunSurvey()));

    // Act
    const actual = MigrationApprovedPlanSchema.parse(JSON.parse(JSON.stringify(approved)));

    // Assert
    should(actual).deepEqual(approved);
  });
});

describe('planMigration — choosing the copy that survives', () => {
  it('should keep the freshest copy in Ferretry when nothing proves the copies are the terminal login', () => {
    // Arrange — no provenance: an absent record is never evidence
    const base = firstRunSurvey({ provenance: [] });
    const homes = base.homes.map(home =>
      home.home.endsWith('claude-auto-default') ? { ...home, freshness: 9_000, fingerprint: 'newer' } : home,
    );

    // Act
    const plan = planMigration({ ...base, homes });

    // Assert
    should(plan.model.credentials['claude-default']).deepEqual({ harness: 'claude', store: 'ferretry' });
    should(decision(plan, 'claude-default')?.source).deepEqual({
      kind: 'copy',
      accountId: id(1),
      wrapper: 'claude-auto-default',
      home: '/fy/fleet/homes/claude-auto-default',
      fingerprint: 'newer',
      reason: 'the freshest copy (the latest expiry)',
    });
    should(decision(plan, 'codex-default')?.source).match({ reason: 'the freshest copy (the latest refresh)' });
    should(decision(plan, 'claude-default')?.retire.length).equal(2);
  });

  it('should not share the terminal login when one copy changed since it was seeded', () => {
    // Arrange
    const base = firstRunSurvey();
    const homes = base.homes.map(home =>
      home.accountId === id(3) ? { ...home, fingerprint: 'rotated', freshness: 5_000 } : home,
    );

    // Act
    const plan = planMigration({ ...base, homes });

    // Assert
    should(decision(plan, 'codex-default')?.store).equal('ferretry');
    should(decision(plan, 'codex-default')?.source).match({ kind: 'copy', accountId: id(3) });
    should(decision(plan, 'claude-default')?.store).equal('host');
  });

  it('should say "the only usable copy" when the others are signed out', () => {
    // Arrange
    const base = firstRunSurvey({ provenance: [] });
    const homes = base.homes.map(home =>
      home.accountId === id(0) ? { ...home, state: 'missing' as const, fingerprint: undefined } : home,
    );

    // Act
    const plan = planMigration({ ...base, homes });

    // Assert
    should(decision(plan, 'claude-default')?.source).match({ kind: 'copy', reason: 'the only usable copy' });
  });

  it('should leave an empty slot that needs sign-in when no copy is usable', () => {
    // Arrange
    const base = firstRunSurvey({ provenance: [] });
    const homes = base.homes.map(home => ({ ...home, state: 'missing' as const }));

    // Act
    const plan = planMigration({ ...base, homes });

    // Assert
    should(decision(plan, 'claude-default')?.source).deepEqual({
      kind: 'empty',
      reason: 'no copy holds a usable login',
    });
    should(plan.notes.map(note => note.message)).containEql(
      'login claude-default has no usable copy (no copy holds a usable login); it needs sign-in after the migration',
    );
  });

  it('should leave an empty slot when no runtime of the login has a config directory', () => {
    // Act
    const plan = planMigration(firstRunSurvey({ homes: [], provenance: [] }));

    // Assert
    should(decision(plan, 'claude-default')?.source).deepEqual({
      kind: 'empty',
      reason: 'no runtime of this login had a config directory to read',
    });
  });
});

describe('planMigration — what refuses it', () => {
  it('should refuse while a copy cannot be read, because the freshest one cannot be chosen', () => {
    // Arrange
    const base = firstRunSurvey();
    const homes = base.homes.map(home =>
      home.accountId === id(0) ? { ...home, state: 'unreadable' as const, reason: 'the keychain is locked' } : home,
    );

    // Act
    const plan = planMigration({ ...base, homes });

    // Assert
    should(plan.blockers.map(blocker => blocker.message)).deepEqual([
      'the login copy in /fy/fleet/homes/claude-default (claude-default) could not be read (the keychain is locked), so the freshest copy of login claude-default cannot be chosen safely; make it readable (unlock the keychain, fix its permissions) and run the migration again',
    ]);
  });

  it('should name an unreadable copy without a reason too', () => {
    // Arrange
    const base = firstRunSurvey();
    const homes = base.homes.map(home => (home.accountId === id(2) ? { ...home, state: 'unreadable' as const } : home));

    // Act
    const plan = planMigration({ ...base, homes });

    // Assert
    should(plan.blockers[0]?.message).startWith(
      'the login copy in /fy/fleet/homes/codex-default (codex-default) could not be read, so',
    );
  });

  it('should refuse while a session runs on a login it moves, naming the sessions', () => {
    // Act
    const plan = planMigration(
      firstRunSurvey({
        liveSessions: [
          { session: 'review', accountId: id(0) },
          { session: 'fix', accountId: id(1) },
          { session: 'chat', accountId: id(2) },
        ],
      }),
    );

    // Assert
    should(plan.blockers.map(blocker => blocker.message)).deepEqual([
      'login claude-default is in use by running sessions review, fix; stop them and run the migration again',
      'login codex-default is in use by running session chat; stop it and run the migration again',
    ]);
  });
});

describe('planMigration — a runtime already living in your own harness directory', () => {
  const ownHomeDocument = {
    agents: [
      {
        name: 'me',
        kind: 'codex',
        routes: { default: route(1, 'codex-me', { home: '~/.codex' }), auto: route(2, 'codex-auto-me') },
      },
    ],
    variants: { default: {}, auto: {} },
  };

  it('should keep the login where it is and never retire the copy in your own directory', () => {
    // Act
    const plan = planMigration(
      survey(ownHomeDocument, {
        homes: [
          homeReading(id(1), 'codex', '/home/someone/.codex'),
          homeReading(id(2), 'codex', '/fy/fleet/homes/codex-auto-me'),
        ],
        host: { codex: { harness: 'codex', directory: '/home/someone/.codex', state: 'valid', fingerprint: 'same' } },
      }),
    );

    // Assert
    const codex = decision(plan, 'codex-me');
    should(codex?.store).equal('host');
    should(codex?.source).match({
      kind: 'host',
      reason: 'a runtime already used your own codex directory, so the login stays shared with your terminal',
    });
    should(codex?.retire.map(item => item.home)).deepEqual(['/fy/fleet/homes/codex-auto-me']);
    should(codex?.link).deepEqual(['/fy/fleet/homes/codex-auto-me']);
    should(plan.blockers).deepEqual([]);
  });

  it('should refuse when a copy elsewhere is newer than your own login', () => {
    // Act
    const plan = planMigration(
      survey(ownHomeDocument, {
        homes: [
          homeReading(id(1), 'codex', '/home/someone/.codex', { freshness: 1 }),
          homeReading(id(2), 'codex', '/fy/fleet/homes/codex-auto-me', { fingerprint: 'newer', freshness: 2 }),
        ],
        host: { codex: { harness: 'codex', directory: '/home/someone/.codex', state: 'valid', fingerprint: 'same' } },
      }),
    );

    // Assert
    should(plan.blockers.map(blocker => blocker.message)).deepEqual([
      'the copy in /fy/fleet/homes/codex-auto-me (codex-auto-me) is newer than your own codex login in /home/someone/.codex, which login codex-me shares; sign your own codex in again, or remove that runtime, and run the migration again',
    ]);
  });

  it('should say so when your own login is not signed in, and keep it as it is', () => {
    // Act
    const plan = planMigration(
      survey(ownHomeDocument, {
        homes: [homeReading(id(1), 'codex', '/home/someone/.codex', { state: 'missing', fingerprint: undefined })],
        host: { codex: { harness: 'codex', directory: '/home/someone/.codex', state: 'missing' } },
      }),
    );

    // Assert
    should(decision(plan, 'codex-me')?.source).match({ kind: 'host', signedIn: false });
    should(plan.notes.map(note => note.message)).containEql(
      'login codex-me is your own codex login, which is not signed in; it stays where it is and needs sign-in',
    );
  });

  it('should refuse a second login in your own directory, since one is already shared with your terminal', () => {
    // Arrange — two login groups, both with a runtime in ~/.claude
    const document = {
      agents: [
        { name: 'a', kind: 'claude', routes: { default: route(1, 'claude-a', { home: '~/.claude' }) } },
        { name: 'b', kind: 'claude', routes: { default: route(2, 'claude-b', { home: '/home/someone/.claude/' }) } },
      ],
    };

    // Act
    const plan = planMigration(
      survey(document, {
        homes: [
          homeReading(id(1), 'claude', '/home/someone/.claude'),
          homeReading(id(2), 'claude', '/home/someone/.claude'),
        ],
        host: {
          claude: { harness: 'claude', directory: '/home/someone/.claude', state: 'valid', fingerprint: 'same' },
        },
      }),
    );

    // Assert
    should(plan.blockers.map(blocker => blocker.message)).containEql(
      'login claude-b lives in your own claude directory, but another login is already shared with your terminal; give one of them its own home first',
    );
  });

  it('should use the layout default when the host was not read', () => {
    // Act
    const plan = planMigration(
      survey(ownHomeDocument, { homes: [homeReading(id(1), 'codex', '/home/someone/.codex')] }),
    );

    // Assert
    should(decision(plan, 'codex-me')?.source).match({
      kind: 'host',
      directory: '/home/someone/.codex',
      signedIn: false,
    });
  });
});

describe('planMigration — the rest of a hand-built fleet', () => {
  it('should keep an environment login as it is, moving nothing', () => {
    // Arrange
    const document = {
      agents: [
        {
          name: 'api',
          kind: 'claude',
          auth: 'api-key',
          env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
          routes: { default: route(1, 'claude-api') },
        },
      ],
    };

    // Act
    const plan = planMigration(survey(document, { liveSessions: [{ session: 'busy', accountId: id(1) }] }));

    // Assert
    should(decision(plan, 'claude-api')).deepEqual({
      id: 'claude-api',
      harness: 'claude',
      store: 'environment',
      source: { kind: 'environment' },
      retire: [],
      link: [],
      runtimes: ['claude-api'],
    });
    should(plan.blockers).deepEqual([]);
  });

  it('should turn each MCP file into MCP servers on the profiles that used it', () => {
    // Arrange
    const document = {
      agents: [
        { name: 'a', kind: 'claude', mcp: './mcp.json', routes: { default: route(1, 'claude-a') } },
        { name: 'b', kind: 'claude', mcp: './other.json', routes: { default: route(2, 'claude-b') } },
        { name: 'c', kind: 'claude', mcp: './broken.json', routes: { default: route(3, 'claude-c') } },
        { name: 'd', kind: 'claude', mcp: './gone.json', routes: { default: route(4, 'claude-d') } },
      ],
    };

    // Act
    const plan = planMigration(
      survey(document, {
        mcpFiles: {
          './mcp.json': {
            ok: true,
            servers: {
              github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'] },
              linear: { url: 'https://mcp.linear.app/sse' },
              bad: { command: 'x', url: 'https://both.example.test' },
            },
          },
          './other.json': { ok: true, servers: { github: { command: 'uvx', args: ['other'] }, again: undefined } },
          './broken.json': { ok: false, reason: 'not JSON' },
        },
      }),
    );

    // Assert
    should(plan.model.components.mcp).deepEqual({
      github: { command: 'npx', args: ['-y', 'server-github'], harness: 'claude' },
      linear: { url: 'https://mcp.linear.app/sse', harness: 'claude' },
      'github-2': { command: 'uvx', args: ['other'], harness: 'claude' },
    });
    should(plan.model.profiles['claude-a']?.layers).containEql('mcp/github');
    should(plan.model.profiles['claude-a']?.layers).containEql('mcp/linear');
    should(plan.model.profiles['claude-b']?.layers).containEql('mcp/github-2');
    const messages = plan.notes.map(note => note.message);
    should(messages).containEql(
      'MCP server "bad" in "./mcp.json" is not one a runtime can start or reach, so it is not carried',
    );
    should(messages).containEql(
      'MCP server "again" in "./other.json" is not one a runtime can start or reach, so it is not carried',
    );
    should(messages).containEql(
      'MCP servers in "./broken.json" could not be read (not JSON), so none are carried; add them again as MCP servers',
    );
    should(messages).containEql(
      'MCP servers in "./gone.json" could not be read (not found), so none are carried; add them again as MCP servers',
    );
  });

  it('should add one MCP server once to a profile that two files both name', () => {
    // Arrange — two runtimes share an MCP file; the same server reached twice is one layer
    const document = {
      agents: [
        {
          name: 'a',
          kind: 'claude',
          mcp: './mcp.json',
          routes: { default: route(1, 'claude-a'), other: route(2, 'claude-b') },
        },
      ],
      variants: { default: {}, other: {} },
    };
    const servers = { github: { command: 'npx' } };

    // Act
    const plan = planMigration(survey(document, { mcpFiles: { './mcp.json': { ok: true, servers } } }));

    // Assert
    should(plan.model.profiles['claude-a']?.layers.filter(layer => layer === 'mcp/github')).length(1);
    should(plan.model.profiles['claude-b']?.layers.filter(layer => layer === 'mcp/github')).length(1);
  });

  it('should note the keychain items that stay until a purge on macOS', () => {
    // Arrange
    const base = firstRunSurvey({ keychain: true });
    const homes = base.homes.map(home =>
      home.harness === 'claude'
        ? {
            ...home,
            copies: [
              ...home.copies,
              { kind: 'keychain' as const, service: `Claude Code-credentials-${home.accountId.slice(-2)}` },
            ],
          }
        : home,
    );

    // Act
    const plan = planMigration({ ...base, homes, provenance: base.provenance });

    // Assert
    should(plan.notes.map(note => note.message)).containEql(
      '2 keychain items holding old copies of login claude-default stay until you purge retired logins',
    );
  });

  it('should note one keychain item in the singular', () => {
    // Arrange
    const document = { agents: [{ name: 'a', kind: 'claude', routes: { default: route(1, 'claude-a') } }] };
    const homes = [
      homeReading(id(1), 'claude', '/fy/fleet/homes/claude-a', {
        copies: [{ kind: 'keychain', service: 'Claude Code-credentials-1' }],
      }),
    ];

    // Act
    const plan = planMigration(survey(document, { homes, keychain: true }));

    // Assert
    should(plan.notes.map(note => note.message)).containEql(
      '1 keychain item holding old copies of login claude-a stay until you purge retired logins',
    );
  });

  it('should not pool history that was already shared, nor a harness with no runtime', () => {
    // Arrange
    const document = {
      agents: [{ name: 'a', kind: 'claude', routes: { default: route(1, 'claude-a') } }],
      sharedHistory: { claude: true },
    };

    // Act
    const plan = planMigration(survey(document));

    // Assert
    should(plan.historyPooled).deepEqual([]);
  });

  it('should read an empty document as an empty fleet', () => {
    // Act
    const empty = planMigration(survey(null));
    const versioned = planMigration(survey({ version: 1 }));

    // Assert
    should(empty.runtimes).deepEqual([]);
    should(versioned.credentials).deepEqual([]);
  });
});

describe('freshestCopy', () => {
  it('should prefer the latest instant, then a valid copy, then the lower route id', () => {
    // Arrange
    const a = homeReading('b', 'claude', '/a', { freshness: 5, state: 'refreshable' });
    const b = homeReading('a', 'claude', '/b', { freshness: 5, state: 'valid' });
    const c = homeReading('c', 'claude', '/c', { freshness: 5, state: 'valid' });
    const d = homeReading('d', 'claude', '/d', { freshness: undefined, state: 'valid' });
    const e = homeReading('e', 'claude', '/e', { freshness: 1, state: 'valid', fingerprint: undefined });

    // Act / Assert
    should(freshestCopy([a, b, c, d, e])?.home).equal('/b');
    should(freshestCopy([c, b])?.home).equal('/b');
    should(freshestCopy([d, a])?.home).equal('/a');
    should(freshestCopy([e])).equal(undefined);
  });
});

describe('everyCopyIsSeeded', () => {
  const home = homeReading('x', 'claude', '/x');

  it('should answer no for a group with no copies at all', () => {
    should(everyCopyIsSeeded([{ ...home, copies: [] }], [record('x', 'claude')])).equal(false);
  });

  it('should answer no for a copy seeded from somewhere else', () => {
    should(everyCopyIsSeeded([home], [{ ...record('x', 'claude'), seededFrom: 'host:codex' }])).equal(false);
  });

  it('should answer no for a copy that changed since its seed', () => {
    should(everyCopyIsSeeded([home], [record('x', 'claude', 'other')])).equal(false);
  });

  it('should answer yes when every copy is the seeded one', () => {
    should(everyCopyIsSeeded([home, { ...home, copies: [] }], [record('x', 'claude')])).equal(true);
  });
});

describe('renderMigrationDryRun', () => {
  it('should print every login, copy, runtime, history move, conversion note and the new config', () => {
    // Arrange
    const plan = planMigration(firstRunSurvey());

    // Act
    const lines = renderMigrationDryRun(plan, 'version: 2\nruntimes: {}\n');

    // Assert
    should(lines).containEql('  claude-default (claude, shared with your terminal)');
    should(lines).containEql(
      '    keeps: your own login in /home/someone/.claude — every copy is still the unchanged copy taken from your own claude login, so Ferretry shares that login instead of keeping copies',
    );
    should(lines).containEql(
      '    retires: /fy/fleet/homes/claude-auto-default/.credentials.json (claude-auto-default)',
    );
    should(lines).containEql('    links: /fy/fleet/homes/codex-default/auth.json to the one login file');
    should(lines).containEql(
      '  claude-auto-default — login claude-default, launched as an agent; its settings folder stays at /fy/fleet/homes/claude-auto-default',
    );
    should(lines).containEql('History: claude and codex conversations become shared by every runtime of that tool.');
    for (const note of plan.conversion.notes)
      should(lines.some(line => line.startsWith(`  - ${note.message}`))).be.true();
    should(lines).containEql('  version: 2');
    should(lines[lines.length - 1]).equal(`Plan ${plan.digest}. Nothing has been changed.`);
  });

  it('should print a kept copy, an empty slot, an environment login, a rename and what blocks it', () => {
    // Arrange
    const document = {
      agents: [
        { name: 'a', kind: 'claude', routes: { default: route(1, 'claude.a') } },
        { name: 'b', kind: 'codex', routes: { default: route(2, 'codex-b') } },
        {
          name: 'c',
          kind: 'claude',
          auth: 'api-key',
          env: { ANTHROPIC_API_KEY: '${secret:K}' },
          routes: { default: route(3, 'claude-c') },
        },
        { name: 'd', kind: 'codex', routes: { default: route(4, 'codex-d') } },
      ],
      sharedHistory: { claude: true, codex: true },
    };
    const plan = planMigration(
      survey(document, {
        homes: [
          homeReading(id(1), 'claude', '/fy/fleet/homes/claude.a'),
          homeReading(id(2), 'codex', '/fy/fleet/homes/codex-b', {
            state: 'missing',
            fingerprint: undefined,
            copies: [],
          }),
          homeReading(id(4), 'codex', '/fy/fleet/homes/codex-d', { state: 'unreadable' }),
        ],
      }),
    );

    // Act
    const lines = renderMigrationDryRun(plan, 'version: 2');

    // Assert
    should(lines).containEql(
      "    keeps: the copy from claude.a (/fy/fleet/homes/claude.a) — the only usable copy; it moves into Ferretry's store",
    );
    should(lines).containEql('    keeps: nothing — no copy holds a usable login; needs sign-in');
    should(lines).containEql('    keeps: its environment variables; nothing to move');
    should(lines.some(line => line.startsWith('  claude-a (was claude.a, which still starts it)'))).be.true();
    should(lines).containEql('History: already shared.');
    should(lines).containEql('Cannot migrate yet:');
    should(lines.some(line => line.endsWith('[profiles]'))).be.true();
  });

  it('should say when a login is used by no runtime and print a note with no path', () => {
    // Arrange
    const plan = planMigration(survey(null));
    const shaped: MigrationPlan = {
      ...plan,
      credentials: [
        {
          id: 'lonely',
          harness: 'claude',
          store: 'ferretry',
          source: { kind: 'empty', reason: 'nothing' },
          retire: [{ accountId: 'x', wrapper: 'w', home: '/h', copy: { kind: 'keychain', service: 'svc' } }],
          link: [],
          runtimes: [],
        },
      ],
      notes: [{ path: [], message: 'pathless' }],
    };

    // Act
    const lines = renderMigrationDryRun(shaped, '');

    // Assert
    should(lines).containEql('    used by: no runtime');
    should(lines).containEql('    retires: keychain item "svc" (w)');
    should(lines).containEql('  - pathless');
  });
});
