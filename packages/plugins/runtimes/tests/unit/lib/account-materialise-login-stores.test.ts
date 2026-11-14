import { describe, it } from 'bun:test';
import should from 'should';
import { EMPTY_RUNTIME_IDS } from '../../../daemon/lib/account/ids.ts';
import { type MaterialiseInput, materialiseFleet } from '../../../daemon/lib/account/materialise.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { FleetLayout, FleetModelApplyPlan } from '../../../daemon/lib/provisioning.ts';

/**
 * A runtime wrapper a PERSON runs is signed in through the stores LOGINS names (`LoginsApi.launchStores`, the projection a
 * ferret's launch also uses), never through a path Runtimes spells itself: Logins keeps a Ferretry-kept login under
 * `<FY_HOME>/state/logins/credentials/<id>`, not `<FY_HOME>/fleet/credentials/<id>`.
 */
const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
};

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const LOGINS_STORE = '/fy/state/logins/credentials';

const MODEL = parseAccountModel({
  version: 1,
  credentials: {
    'claude-work': { harness: 'claude', store: 'ferretry' },
    'codex-work': { harness: 'codex', store: 'ferretry' },
  },
  components: {
    modelSets: {
      claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
      codex: { models: ['gpt-6'], default: 'gpt-6' },
    },
  },
  profiles: { default: { layers: ['modelSets/claude', 'modelSets/codex'] } },
  runtimes: {
    'claude-default': { credential: 'claude-work', profile: 'default' },
    'codex-default': { credential: 'codex-work', profile: 'default' },
  },
});

const STORES: MaterialiseInput['loginStores'] = [
  { id: 'claude-work', variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${LOGINS_STORE}/claude-work` } },
];

const plan = (overrides: Partial<MaterialiseInput> = {}): FleetModelApplyPlan => {
  const ids = [ID_A, ID_B];
  return materialiseFleet({
    model: MODEL,
    layout: LAYOUT,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => ids.shift() ?? 'exhausted',
    generatedAt: '2026-11-14T08:00:00.000Z',
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    hostCodexHome: '/home/person/.codex',
    acceptsAutoPermissionMode: true,
    ...overrides,
  });
};

const wrapperOf = (result: FleetModelApplyPlan, name: string): string => {
  const operation = result.operations.find(candidate => candidate.path === `/fy/fleet/bin/${name}`);
  if (operation?.kind !== 'file') throw new Error(`${name} is not a file`);
  return operation.content;
};

describe('materialiseFleet — a Ferretry-kept login is reached through the store Logins names', () => {
  it('should sign a Claude wrapper in at the Logins store, not the fleet directory', () => {
    // Act
    const result = plan({ loginStores: STORES });

    // Assert
    const wrapper = wrapperOf(result, 'claude-default');
    should(wrapper).containEql(`export CLAUDE_SECURESTORAGE_CONFIG_DIR='${LOGINS_STORE}/claude-work'`);
    should(wrapper).not.containEql('/fy/fleet/credentials');
  });

  it("should not link a Codex runtime's auth.json to the old fleet store (declared GAP: Logins' file is the kernel's to link)", () => {
    // Act
    const result = plan({ loginStores: STORES });

    // Assert
    should(result.operations.filter(operation => operation.path === `/fy/fleet/homes/${ID_B}/auth.json`)).be.empty();
  });

  it('should not create, or name, any directory under fleet/credentials: Logins keeps its own stores', () => {
    // Act
    const result = plan({ loginStores: STORES });

    // Assert
    should(JSON.stringify(result.operations)).not.containEql('fleet/credentials');
  });

  it('should publish a runtime unlaunchable, naming the login, when Logins names no store for it', () => {
    // Act
    const result = plan({ loginStores: [] });

    // Assert
    should(JSON.stringify(result.operations)).not.containEql('fleet/credentials');
    should(JSON.stringify(result.manifest)).containEql('its login \\"claude-work\\" cannot be reached');
    should(wrapperOf(result, 'claude-default')).not.containEql('CLAUDE_SECURESTORAGE_CONFIG_DIR');
  });
});
