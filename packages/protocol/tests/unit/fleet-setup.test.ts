/**
 * The wire shape of a machine's setup: the first-run scan, installing a tool, the Clone export and
 * migrating an old account format.
 *
 * Every object is strict, so a field the daemon grew without declaring it is REFUSED rather than stripped.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as setup from '../../src/lib/fleet-setup.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const installed = { harness: 'claude', label: 'Claude Code', installed: true };
const missing = {
  harness: 'codex',
  label: 'Codex',
  installed: false,
  install: { kind: 'runnable', command: 'npm install -g @openai/codex' },
};

const harnessScan = {
  harness: 'claude',
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
  runtimes: [{ harness: 'claude', name: 'claude-default', profile: 'default' }],
  updates: [{ reference: 'instructions/main', sources: ['/h/.claude/CLAUDE.md'] }],
  duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
  notes: [{ harness: 'claude', text: 'CLAUDE.md and AGENTS.md say the same thing.' }],
  importing: { available: true },
};

const bundle = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'studio-mac',
  exportedAt: INSTANT,
  credentials: [{ id: 'claude-you', harness: 'claude', label: 'you', email: 'person@example.test' }],
  components: { instructions: { main: { file: 'components/instructions/main.md' } } },
  profiles: { default: { layers: ['instructions/main'] } },
  runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
  files: [{ path: 'components/instructions/main.md', content: '# Main' }],
  notCopied: [{ path: '/etc/hosts', reason: 'outside the asset tree' }],
};

const migrated = {
  outcome: 'migrated',
  resumed: false,
  credentials: [{ id: 'claude-you', harness: 'claude', store: 'host', retired: 0 }],
  runtimes: [{ name: 'claude-default', formerName: 'default' }],
};

const cases: SchemaCase[] = [
  {
    name: 'FleetToolInstallPlanSchema',
    schema: setup.FleetToolInstallPlanSchema,
    value: { kind: 'no-package-manager', reason: 'No brew or npm was found.', manualCommand: 'npm i -g x' },
  },
  { name: 'FleetSetupToolSchema', schema: setup.FleetSetupToolSchema, value: missing },
  {
    name: 'FleetToolInstallRequestSchema',
    schema: setup.FleetToolInstallRequestSchema,
    value: { harnesses: ['claude', 'codex'], operatorPassword: 'fake-password-123' },
  },
  {
    name: 'FleetToolInstallOutcomeSchema',
    schema: setup.FleetToolInstallOutcomeSchema,
    value: {
      harness: 'codex',
      outcome: 'failed',
      cause: 'needs-admin',
      reason: 'Installing needs administrator rights.',
      manualCommand: 'sudo npm i -g x',
    },
  },
  {
    name: 'FleetToolInstallResultSchema',
    schema: setup.FleetToolInstallResultSchema,
    value: {
      outcomes: [
        { harness: 'claude', outcome: 'already-installed' },
        { harness: 'codex', outcome: 'installed', command: 'npm i -g x' },
      ],
    },
  },
  {
    name: 'FleetHostLoginSchema',
    schema: setup.FleetHostLoginSchema,
    value: { state: 'unreadable', reason: 'The keychain is locked.' },
  },
  { name: 'FleetHarnessScanSchema', schema: setup.FleetHarnessScanSchema, value: harnessScan },
  { name: 'FleetSetupRuntimeSchema', schema: setup.FleetSetupRuntimeSchema, value: scan.runtimes[0] },
  { name: 'FleetSetupUpdateSchema', schema: setup.FleetSetupUpdateSchema, value: scan.updates[0] },
  { name: 'FleetSetupDuplicateSchema', schema: setup.FleetSetupDuplicateSchema, value: scan.duplicates[0] },
  { name: 'FleetSetupScanSchema', schema: setup.FleetSetupScanSchema, value: scan },
  { name: 'FleetCloneCredentialSchema', schema: setup.FleetCloneCredentialSchema, value: bundle.credentials[0] },
  { name: 'FleetCloneFileSchema', schema: setup.FleetCloneFileSchema, value: bundle.files[0] },
  { name: 'FleetCloneBundleSchema', schema: setup.FleetCloneBundleSchema, value: bundle },
  {
    name: 'FleetMigrationViewSchema',
    schema: setup.FleetMigrationViewSchema,
    value: {
      status: 'version-1',
      dryRun: { digest: 'abc123', lines: ['Moves 2 accounts.'], blockers: [] },
      inProgress: { digest: 'abc123', startedAt: INSTANT },
      migrate: { available: false, reason: 'A session is live.' },
    },
  },
  {
    name: 'FleetMigrationApplyRequestSchema',
    schema: setup.FleetMigrationApplyRequestSchema,
    value: { digest: 'abc123', operatorPassword: 'fake-password-123' },
  },
  { name: 'FleetMigrationOutcomeSchema', schema: setup.FleetMigrationOutcomeSchema, value: migrated },
  { name: 'FleetSetupRefusalCodeSchema', schema: setup.FleetSetupRefusalCodeSchema, value: 'fleet_setup_busy' },
];

const rejects = (name: string, schema: SchemaCase['schema'], value: unknown): SchemaCase => ({ name, schema, value });

describe('the machine setup wire contract', () => {
  it('should round-trip every shape a browser reads and every request it may send', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(setup, cases);
  });

  it('should accept every variant of a tool, an install outcome and a migration outcome', () => {
    // Arrange
    const values: SchemaCase[] = [
      { name: 'installed tool', schema: setup.FleetSetupToolSchema, value: installed },
      {
        name: 'manual install plan',
        schema: setup.FleetToolInstallPlanSchema,
        value: { kind: 'runnable', command: 'brew install claude' },
      },
      {
        name: 'installed outcome',
        schema: setup.FleetToolInstallOutcomeSchema,
        value: { harness: 'codex', outcome: 'installed', command: 'npm i -g x' },
      },
      {
        name: 'already installed outcome',
        schema: setup.FleetToolInstallOutcomeSchema,
        value: { harness: 'codex', outcome: 'already-installed' },
      },
      {
        name: 'refused migration',
        schema: setup.FleetMigrationOutcomeSchema,
        value: { outcome: 'refused', reasons: ['A session is live.'] },
      },
      {
        name: 'rolled-back migration',
        schema: setup.FleetMigrationOutcomeSchema,
        value: { outcome: 'rolled-back', reason: 'The disk is full.', unrestored: [] },
      },
      {
        name: 'a minimal migration view',
        schema: setup.FleetMigrationViewSchema,
        value: { status: 'no-fleet', migrate: { available: true } },
      },
      {
        name: 'a minimal clone credential',
        schema: setup.FleetCloneCredentialSchema,
        value: { id: 'codex-work', harness: 'codex' },
      },
    ];

    // Act & Assert
    assertRoundTrips(values);
  });

  it('should name the bundle format and every refusal code', () => {
    // Act & Assert
    should(setup.FLEET_CLONE_BUNDLE_FORMAT).equal('ferretry-clone');
    should([...setup.FLEET_SETUP_REFUSAL_CODES]).deepEqual([
      'fleet_setup_disabled',
      'fleet_setup_unreadable',
      'fleet_setup_refused',
      'fleet_setup_unauthorized',
      'fleet_setup_busy',
    ]);
  });

  it('should refuse an unknown field, a wrong discriminator and a malformed value', () => {
    // Arrange / Act / Assert
    assertRejects([
      rejects('an install plan of an unknown kind', setup.FleetToolInstallPlanSchema, { kind: 'magic' }),
      rejects('a runnable plan with an extra key', setup.FleetToolInstallPlanSchema, {
        kind: 'runnable',
        command: 'x',
        sudo: true,
      }),
      rejects('a missing tool with no install plan', setup.FleetSetupToolSchema, { ...installed, installed: false }),
      rejects('an installed tool carrying a plan', setup.FleetSetupToolSchema, {
        ...installed,
        install: missing.install,
      }),
      rejects('a tool of an unknown harness', setup.FleetSetupToolSchema, { ...installed, harness: 'gemini' }),
      rejects('an install request naming no harness', setup.FleetToolInstallRequestSchema, { harnesses: [] }),
      rejects('an install request naming three harnesses', setup.FleetToolInstallRequestSchema, {
        harnesses: ['claude', 'codex', 'claude'],
      }),
      rejects('an install request with a short password', setup.FleetToolInstallRequestSchema, {
        harnesses: ['claude'],
        operatorPassword: 'short',
      }),
      rejects('an install outcome of an unknown kind', setup.FleetToolInstallOutcomeSchema, {
        harness: 'claude',
        outcome: 'exploded',
      }),
      rejects('a failed install with an unknown cause', setup.FleetToolInstallOutcomeSchema, {
        harness: 'claude',
        outcome: 'failed',
        cause: 'gremlins',
        reason: 'x',
        manualCommand: 'x',
      }),
      rejects('a login with an unknown state', setup.FleetHostLoginSchema, { state: 'maybe' }),
      rejects('a login carrying a token', setup.FleetHostLoginSchema, { state: 'signed-in', token: 'fake' }),
      rejects('a harness scan carrying a secret value', setup.FleetHarnessScanSchema, {
        ...harnessScan,
        secretValues: { ANTHROPIC_API_KEY: 'fake' },
      }),
      rejects('a scan with an unknown format', setup.FleetSetupScanSchema, { ...scan, format: 'version-3' }),
      rejects('a scan with an extra key', setup.FleetSetupScanSchema, { ...scan, extra: true }),
      rejects('an unavailable act with no reason', setup.FleetSetupScanSchema, {
        ...scan,
        importing: { available: false },
      }),
      rejects('a clone credential with an extra key', setup.FleetCloneCredentialSchema, {
        ...bundle.credentials[0],
        token: 'fake',
      }),
      rejects('a clone file with a numeric content', setup.FleetCloneFileSchema, { path: 'a', content: 1 }),
      rejects('a bundle of another format', setup.FleetCloneBundleSchema, { ...bundle, format: 'other' }),
      rejects('a bundle of another version', setup.FleetCloneBundleSchema, { ...bundle, version: 2 }),
      rejects('a bundle with an extra key', setup.FleetCloneBundleSchema, { ...bundle, history: [] }),
      rejects('a bundle exported at no instant', setup.FleetCloneBundleSchema, { ...bundle, exportedAt: 'yesterday' }),
      rejects('a bundle not carrying its files', setup.FleetCloneBundleSchema, { ...bundle, files: undefined }),
      rejects('a migration view of an unknown status', setup.FleetMigrationViewSchema, {
        status: 'half-done',
        migrate: { available: true },
      }),
      rejects('a migration apply request naming no digest', setup.FleetMigrationApplyRequestSchema, {}),
      rejects('a migration outcome of an unknown kind', setup.FleetMigrationOutcomeSchema, { outcome: 'vanished' }),
      rejects('a migrated outcome with a credential of an unknown store', setup.FleetMigrationOutcomeSchema, {
        ...migrated,
        credentials: [{ id: 'x', harness: 'claude', store: 'cloud', retired: 0 }],
      }),
      rejects('a refusal code nobody declared', setup.FleetSetupRefusalCodeSchema, 'fleet_setup_bad'),
    ]);
  });
});
