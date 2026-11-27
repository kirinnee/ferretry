/**
 * E-276 0a: the catalogue projections that carry per-harness words to the surfaces — `machineView`, `componentCatalog`,
 * `profileCatalog` (the fixed-layer view, the per-model fast-mode flag, the partial-support notes) and `runtimeCatalog` — for one
 * machine holding every harness × login store, under each Agent permissions choice, with and without the model catalogs.
 */
import { describe, it } from 'bun:test';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import {
  type CatalogFacts,
  componentCatalog,
  machineView,
  profileCatalog,
  runtimeCatalog,
} from '../../../daemon/lib/service/catalog.ts';
import { GOLDEN_CATALOGS } from './support/catalogs.ts';
import { expectGolden } from './support/golden.ts';
import { RUNTIME_ID } from './support/world.ts';

const document = (agentPermissions: 'auto' | 'skip') => ({
  version: 1,
  machine: { agentPermissions },
  credentials: {
    'claude-host': { harness: 'claude', store: 'host' },
    'claude-kept': { harness: 'claude', store: 'ferretry', label: 'Work' },
    'claude-env': {
      harness: 'claude',
      store: 'environment',
      preset: 'golden-gateway',
      env: { ANTHROPIC_API_KEY: '${secret:GOLDEN_KEY}' },
    },
    'codex-host': { harness: 'codex', store: 'host' },
    'codex-kept': { harness: 'codex', store: 'ferretry' },
    'codex-env': { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: '${secret:GOLDEN_KEY}' } },
  },
  components: {
    instructions: {
      main: { file: 'components/instructions/main.md' },
      imports: { file: 'components/instructions/imports.md' },
    },
    mcp: {
      files: { command: 'npx', args: ['server-files'], env: { FILES_TOKEN: '${secret:GOLDEN_FILES}' } },
      docs: { url: 'https://docs.example.test/mcp' },
      feed: { url: 'https://feed.example.test/sse' },
      notes: { url: 'https://notes.example.test/mcp', auth: 'oauth' },
    },
    skills: { mine: { items: ['review'] } },
    settings: {
      claudeSettings: {
        harness: 'claude',
        file: 'components/settings/claude.json',
        flags: ['--verbose'],
        env: { KEPT: 'yes' },
      },
      codexSettings: { harness: 'codex', file: 'components/settings/codex.toml' },
    },
    modelSets: {
      claude: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], default: 'claude-opus-5-5' },
      codex: { models: ['gpt-6', 'gpt-6-mini'], default: 'gpt-6' },
    },
  },
  profiles: {
    claude: {
      layers: [
        'instructions/main',
        'mcp/files',
        'mcp/feed',
        'skills/mine',
        'settings/claudeSettings',
        'modelSets/claude',
      ],
    },
    codex: {
      layers: [
        'instructions/imports',
        'mcp/docs',
        'mcp/notes',
        'skills/mine',
        'settings/codexSettings',
        'modelSets/codex',
      ],
    },
    mixed: { layers: ['instructions/main', 'settings/claudeSettings', 'settings/codexSettings', 'modelSets/codex'] },
    empty: { layers: [] },
  },
  runtimes: {
    'claude-host': { credential: 'claude-host', profile: 'claude' },
    'claude-kept': { credential: 'claude-kept', profile: 'claude' },
    'claude-env': { credential: 'claude-env', profile: 'claude' },
    'codex-host': { credential: 'codex-host', profile: 'codex' },
    'codex-kept': { credential: 'codex-kept', profile: 'codex' },
    'codex-env': { credential: 'codex-env', profile: 'codex' },
    'claude-on-mixed': { credential: 'claude-host', profile: 'mixed' },
    'codex-on-empty': { credential: 'codex-host', profile: 'empty' },
  },
});

const facts = (accepts: boolean, catalogs: boolean): CatalogFacts => ({
  format: 'present',
  machineName: 'golden-machine',
  tools: { claude: '/opt/harness/bin/claude', codex: '/opt/harness/bin/codex' },
  runningSessions: 0,
  runtimeIds: Object.fromEntries(
    Object.keys(document('auto').runtimes).map((name, index) => [
      name,
      `${RUNTIME_ID.slice(0, -2)}${String(index).padStart(2, '0')}`,
    ]),
  ),
  userHome: '/home/person',
  acceptsAutoPermissionMode: accepts,
  settingsBodies: { claudeSettings: { model: 'claude-opus-5-5' }, codexSettings: { model: 'gpt-6' } },
  instructionBodies: { main: 'Be kind.\n', imports: 'See\n@docs/guide.md\n' },
  skillFrontmatter: { review: ['name', 'allowed-tools', 'model'] },
  ...(catalogs ? { modelCatalogs: GOLDEN_CATALOGS } : {}),
});

describe('catalogue projection goldens', () => {
  for (const [permissions, accepts] of [
    ['auto', true],
    ['auto', false],
    ['skip', true],
  ] as const) {
    for (const catalogs of [false, true]) {
      it(`should project a machine on ${permissions} (Claude accepts auto: ${accepts}, catalogs: ${catalogs}) exactly as the base does`, () => {
        const model = parseAccountModel(document(permissions));
        const read = facts(accepts, catalogs);
        expectGolden(
          `catalog/${permissions}-${accepts ? 'accepted' : 'refused'}-${catalogs ? 'catalogs' : 'no-catalogs'}`,
          {
            machine: machineView(model, read, { mayApply: true, applyRefusal: 'granted' }),
            components: componentCatalog(model, read),
            profiles: profileCatalog(model, read),
            runtimes: runtimeCatalog(model, read),
          },
        );
      });
    }
  }
});
