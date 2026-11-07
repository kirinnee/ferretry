/**
 * The wire shape of a machine's setup: the first-run scan, installing a tool and the Clone export.
 *
 * Every object is strict, so a field the daemon grew without declaring it is REFUSED rather than stripped.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as setup from '../../../contract/wire/setup.ts';
import { INSTANT } from './fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const installed = { harness: 'claude-code', label: 'Claude Code', installed: true };
const missing = {
  harness: 'codex',
  label: 'Codex',
  installed: false,
  install: { kind: 'runnable', command: 'npm install -g @openai/codex' },
};

const harnessScan = {
  harness: 'claude-code',
  installed: true,
  account: { state: 'signed-in', email: 'person@example.test' },
  instructions: { name: 'main', source: '/h/.claude/CLAUDE.md', bytes: 120 },
  settings: { source: '/h/.claude/settings.json', count: 3, hooks: 1 },
  mcpServers: ['notes'],
  skills: ['review'],
  secretKeys: ['env.ANTHROPIC_API_KEY'],
  missingCommands: ['uvx'],
  problems: [],
};

const scan = {
  machine: 'work-linux',
  format: 'none',
  tools: [installed, missing],
  harnesses: [harnessScan],
  instructionsIdentical: true,
  runtimes: [{ harness: 'claude-code', name: 'claude-default', profile: 'default' }],
  updates: [{ reference: 'instructions/main', sources: ['/h/.claude/CLAUDE.md'] }],
  duplicates: [{ harness: 'claude-code', existing: 'claude-default', suggested: 'claude-default-2' }],
  notes: [{ harness: 'claude-code', text: 'CLAUDE.md and AGENTS.md say the same thing.' }],
  importing: { available: true },
};

const KEY = 'abcdefghijklmnopqrstuvwxyz';

const bundle = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'studio-mac',
  daemon: 'daemon-source',
  exportedAt: INSTANT,
  credentials: [{ id: 'claude-you', harness: 'claude-code', label: 'you', email: 'person@example.test' }],
  components: { instructions: { main: { file: 'components/instructions/main.md' } } },
  profiles: { default: { layers: ['instructions/main'] } },
  runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
  files: [{ path: 'components/instructions/main.md', content: '# Main' }],
  notCopied: [{ path: '/etc/hosts', reason: 'outside the asset tree' }],
  keys: { 'instructions/main': KEY },
};

const cases: SchemaCase[] = [
  {
    name: 'ToolInstallPlanSchema',
    schema: setup.ToolInstallPlanSchema,
    value: { kind: 'no-package-manager', reason: 'No brew or npm was found.', manualCommand: 'npm i -g x' },
  },
  { name: 'SetupToolSchema', schema: setup.SetupToolSchema, value: missing },
  {
    name: 'ToolInstallRequestSchema',
    schema: setup.ToolInstallRequestSchema,
    value: { harnesses: ['claude-code', 'codex'] },
  },
  {
    name: 'ToolInstallOutcomeSchema',
    schema: setup.ToolInstallOutcomeSchema,
    value: {
      harness: 'codex',
      outcome: 'failed',
      cause: 'needs-admin',
      reason: 'Installing needs administrator rights.',
      manualCommand: 'sudo npm i -g x',
    },
  },
  {
    name: 'ToolInstallResultSchema',
    schema: setup.ToolInstallResultSchema,
    value: {
      outcomes: [
        { harness: 'claude-code', outcome: 'already-installed' },
        { harness: 'codex', outcome: 'installed', command: 'npm i -g x' },
      ],
    },
  },
  {
    name: 'HostLoginSchema',
    schema: setup.HostLoginSchema,
    value: { state: 'unreadable', reason: 'The keychain is locked.' },
  },
  { name: 'HarnessScanSchema', schema: setup.HarnessScanSchema, value: harnessScan },
  { name: 'SetupRuntimeSchema', schema: setup.SetupRuntimeSchema, value: scan.runtimes[0] },
  { name: 'SetupUpdateSchema', schema: setup.SetupUpdateSchema, value: scan.updates[0] },
  { name: 'SetupDuplicateSchema', schema: setup.SetupDuplicateSchema, value: scan.duplicates[0] },
  { name: 'SetupScanSchema', schema: setup.SetupScanSchema, value: scan },
  { name: 'CloneCredentialSchema', schema: setup.CloneCredentialSchema, value: bundle.credentials[0] },
  { name: 'CloneFileSchema', schema: setup.CloneFileSchema, value: bundle.files[0] },
  { name: 'CloneBundleSchema', schema: setup.CloneBundleSchema, value: bundle },
  { name: 'OriginKeySchema', schema: setup.OriginKeySchema, value: KEY },
  { name: 'CloneKeyReferenceSchema', schema: setup.CloneKeyReferenceSchema, value: 'profile/default' },
  { name: 'SetupRefusalCodeSchema', schema: setup.SetupRefusalCodeSchema, value: 'fleet_setup_busy' },
];

const rejects = (name: string, schema: SchemaCase['schema'], value: unknown): SchemaCase => ({ name, schema, value });

describe('the machine setup wire contract', () => {
  it('should round-trip every shape a browser reads and every request it may send', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(setup, cases);
  });

  it('should accept every variant of a tool, and an install outcome', () => {
    // Arrange
    const values: SchemaCase[] = [
      { name: 'installed tool', schema: setup.SetupToolSchema, value: installed },
      {
        name: 'manual install plan',
        schema: setup.ToolInstallPlanSchema,
        value: { kind: 'runnable', command: 'brew install claude' },
      },
      {
        name: 'installed outcome',
        schema: setup.ToolInstallOutcomeSchema,
        value: { harness: 'codex', outcome: 'installed', command: 'npm i -g x' },
      },
      {
        name: 'already installed outcome',
        schema: setup.ToolInstallOutcomeSchema,
        value: { harness: 'codex', outcome: 'already-installed' },
      },
      {
        name: 'a minimal clone credential',
        schema: setup.CloneCredentialSchema,
        value: { id: 'codex-work', harness: 'codex' },
      },
    ];

    // Act & Assert
    assertRoundTrips(values);
  });

  it('should carry a dual login’s halves, and parse without them for a login that drives one CLI', () => {
    // Act
    const dual = setup.CloneCredentialSchema.parse({
      ...bundle.credentials[0],
      store: 'environment',
      claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
      codex: { env: { OPENROUTER_API_KEY: '${secret:S}' }, codexProvider: { id: 'openrouter' } },
    });
    const single = setup.CloneCredentialSchema.parse(bundle.credentials[0]);

    // Assert
    should(dual.claude).deepEqual({ env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } });
    should(dual.codex).deepEqual({ env: { OPENROUTER_API_KEY: '${secret:S}' }, codexProvider: { id: 'openrouter' } });
    should(single).not.have.property('claude-code');
    should(single).not.have.property('codex');
  });

  it('should name the bundle format and every refusal code', () => {
    // Act & Assert
    should(setup.CLONE_BUNDLE_FORMAT).equal('ferretry-clone');
    should([...setup.SETUP_REFUSAL_CODES]).deepEqual([
      'fleet_setup_unreadable',
      'fleet_setup_refused',
      'fleet_setup_unauthorized',
      'fleet_setup_busy',
    ]);
  });

  it('should refuse an unknown field, a wrong discriminator and a malformed value', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('an install plan of an unknown kind', setup.ToolInstallPlanSchema, { kind: 'magic' }),
      rejects('a runnable plan with an extra key', setup.ToolInstallPlanSchema, {
        kind: 'runnable',
        command: 'x',
        sudo: true,
      }),
      rejects('a missing tool with no install plan', setup.SetupToolSchema, { ...installed, installed: false }),
      rejects('an installed tool carrying a plan', setup.SetupToolSchema, {
        ...installed,
        install: missing.install,
      }),
      rejects('a tool of an unknown harness', setup.SetupToolSchema, { ...installed, harness: 'gemini' }),
      rejects('an install request naming no harness', setup.ToolInstallRequestSchema, { harnesses: [] }),
      rejects('an install request naming three harnesses', setup.ToolInstallRequestSchema, {
        harnesses: ['claude-code', 'codex', 'claude-code'],
      }),
      rejects('an install request still carrying a confirmation', setup.ToolInstallRequestSchema, {
        harnesses: ['claude-code'],
        operatorPassword: 'fake-password-123',
      }),
      rejects('an install outcome of an unknown kind', setup.ToolInstallOutcomeSchema, {
        harness: 'claude-code',
        outcome: 'exploded',
      }),
      rejects('a failed install with an unknown cause', setup.ToolInstallOutcomeSchema, {
        harness: 'claude-code',
        outcome: 'failed',
        cause: 'gremlins',
        reason: 'x',
        manualCommand: 'x',
      }),
      rejects('a login with an unknown state', setup.HostLoginSchema, { state: 'maybe' }),
      rejects('a login carrying a token', setup.HostLoginSchema, { state: 'signed-in', token: 'fake' }),
      rejects('a harness scan carrying a secret value', setup.HarnessScanSchema, {
        ...harnessScan,
        secretValues: { ANTHROPIC_API_KEY: 'fake' },
      }),
      rejects('a scan with an unknown format', setup.SetupScanSchema, { ...scan, format: 'version-3' }),
      rejects('a scan with an extra key', setup.SetupScanSchema, { ...scan, extra: true }),
      rejects('an unavailable act with no reason', setup.SetupScanSchema, {
        ...scan,
        importing: { available: false },
      }),
      rejects('a clone credential with an extra key', setup.CloneCredentialSchema, {
        ...bundle.credentials[0],
        token: 'fake',
      }),
      rejects('a clone file with a numeric content', setup.CloneFileSchema, { path: 'a', content: 1 }),
      rejects('a bundle of another format', setup.CloneBundleSchema, { ...bundle, format: 'other' }),
      rejects('a bundle of another version', setup.CloneBundleSchema, { ...bundle, version: 3 }),
      rejects('a bundle without its keys', setup.CloneBundleSchema, { ...bundle, keys: undefined }),
      rejects('a bundle without its daemon', setup.CloneBundleSchema, {
        ...bundle,
        daemon: undefined,
      }),
      rejects('a bundle with an extra key', setup.CloneBundleSchema, { ...bundle, history: [] }),
      rejects('a key that is not 16 bytes of base32', setup.OriginKeySchema, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      rejects('a key that is too short', setup.OriginKeySchema, KEY.slice(1)),
      rejects('a key with a padding character', setup.OriginKeySchema, `${KEY.slice(1)}=`),
      rejects('a key naming no subject', setup.CloneKeyReferenceSchema, 'main'),
      rejects('a bundle naming a key that is not a key', setup.CloneBundleSchema, {
        ...bundle,
        keys: { 'instructions/main': 'x' },
      }),
      rejects('a bundle with an extra key', setup.CloneBundleSchema, { ...bundle, history: [] }),
      rejects('a bundle exported at no instant', setup.CloneBundleSchema, { ...bundle, exportedAt: 'yesterday' }),
      rejects('a bundle not carrying its files', setup.CloneBundleSchema, { ...bundle, files: undefined }),
      rejects('a refusal code nobody declared', setup.SetupRefusalCodeSchema, 'fleet_setup_bad'),
    ]);
  });

  it('should accept a bundle, and cap the keys it carries', () => {
    // Arrange
    const keysOf = (count: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`instructions/item-${String(index)}`, KEY]));

    // Act & Assert
    should(setup.CloneBundleSchema.parse(bundle).version).equal(1);
    should(
      setup.CloneBundleSchema.safeParse({ ...bundle, keys: keysOf(setup.CLONE_BUNDLE_KEYS_LIMIT) }).success,
    ).be.true();
    should(
      setup.CloneBundleSchema.safeParse({ ...bundle, keys: keysOf(setup.CLONE_BUNDLE_KEYS_LIMIT + 1) }).success,
    ).be.false();
  });
});
