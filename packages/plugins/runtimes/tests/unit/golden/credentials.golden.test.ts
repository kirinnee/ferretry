/**
 * E-276 0a: the credential store — `resolveCredentialStore` for each harness × store (host, Ferretry-kept with and without
 * Logins' answer, environment, an environment login on a Codex model provider that can and cannot be put together), and what
 * each resolution turns into: the launch environment, the launch arguments, the sign-in links, the host Codex home.
 */
import { describe, it } from 'bun:test';
import {
  codexCredentialLink,
  codexWrapperLink,
  credentialLaunchArguments,
  credentialLaunchEnvironment,
  type CredentialStoreResolution,
  hostCodexHome,
  isSignInName,
  resolveCredentialStore,
} from '../../../daemon/lib/account/credentials.ts';
import { organizationTypeOfAccountDocument } from '../../../daemon/lib/account-organization-type.ts';
import { loginOrganizationType } from '../../../daemon/lib/login-organization-type.ts';
import type { LoginLaunchStore, LoginsApi } from '@ferretry/plugin-logins/contract';
import { claudeRuntimesKit } from '../../../../claude-code/daemon/lib/runtimes-kit/index.ts';
import { codexRuntimesKit } from '../../../../codex/daemon/lib/runtimes-kit/index.ts';
import type { Credential } from '../../../daemon/lib/account/schema.ts';
import { expectGolden } from './support/golden.ts';
import { outcome, THIRD_KEY } from './support/thrown.ts';

const kits = new Map([
  ['claude', claudeRuntimesKit],
  ['codex', codexRuntimesKit],
] as const);
const HOME = '/home/person';
const PATHS = { userHome: HOME, hostCodexHome: `${HOME}/.codex` } as const;
const RUNTIME_HOME = '/fy/fleet/homes/golden';

const KEPT: ReadonlyMap<string, LoginLaunchStore> = new Map<string, LoginLaunchStore>([
  [
    'claude-kept',
    { id: 'claude-kept', variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fy/state/logins/credentials/claude-kept' } },
  ],
  ['codex-kept', { id: 'codex-kept', variables: {}, signInFile: '/fy/state/logins/credentials/codex-kept/auth.json' }],
]);

const PROVIDER = {
  id: 'golden',
  name: 'Golden',
  baseUrl: 'https://llm.example.test/v1',
  keyVariable: 'PROVIDER_API_KEY',
  model: 'golden-model',
};

const CASES: Readonly<
  Record<
    string,
    {
      id: string;
      credential: Credential;
      paths?: typeof PATHS | { userHome: string };
      stores?: ReadonlyMap<string, LoginLaunchStore>;
    }
  >
> = {
  'claude-host': { id: 'claude-host', credential: { harness: 'claude', store: 'host' } },
  'claude-kept': { id: 'claude-kept', credential: { harness: 'claude', store: 'ferretry' }, stores: KEPT },
  'claude-kept-unnamed': { id: 'claude-other', credential: { harness: 'claude', store: 'ferretry' }, stores: KEPT },
  'claude-environment': {
    id: 'claude-env',
    credential: { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:GOLDEN_KEY}' } },
  },
  'codex-host': { id: 'codex-host', credential: { harness: 'codex', store: 'host' } },
  'codex-host-unnamed-home': {
    id: 'codex-host',
    credential: { harness: 'codex', store: 'host' },
    paths: { userHome: HOME },
  },
  'codex-kept': { id: 'codex-kept', credential: { harness: 'codex', store: 'ferretry' }, stores: KEPT },
  'codex-kept-unnamed': { id: 'codex-other', credential: { harness: 'codex', store: 'ferretry' }, stores: KEPT },
  'codex-environment': {
    id: 'codex-env',
    credential: { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: '${secret:GOLDEN_KEY}' } },
  },
  'codex-environment-provider': {
    id: 'codex-provider',
    credential: {
      harness: 'codex',
      store: 'environment',
      env: { PROVIDER_API_KEY: '${secret:GOLDEN_KEY}' },
      codexProvider: PROVIDER,
    },
  },
  'codex-environment-provider-problem': {
    id: 'codex-provider-problem',
    credential: {
      harness: 'codex',
      store: 'environment',
      env: {},
      codexProvider: PROVIDER,
    },
  },
};

describe('credential store goldens', () => {
  for (const [name, entry] of Object.entries(CASES)) {
    it(`should resolve ${name} exactly as the base does`, () => {
      const paths = entry.paths ?? PATHS;
      const resolution = resolveCredentialStore(
        entry.id,
        entry.credential,
        paths,
        kits,
        entry.credential.harness,
        entry.stores,
      );
      const follow = (resolved: CredentialStoreResolution) => ({
        resolution: resolved,
        launchEnvironment: credentialLaunchEnvironment(resolved, kits),
        launchArguments: credentialLaunchArguments(resolved),
        launchArgumentsWhenProfileNamesModel: credentialLaunchArguments(resolved, true),
        homeLink: codexCredentialLink(RUNTIME_HOME, resolved) ?? null,
        wrapperLink: codexWrapperLink(RUNTIME_HOME, resolved) ?? null,
      });
      expectGolden(`credentials/${name}`, follow(resolution));
    });
  }

  it('should resolve the host Codex home and the sign-in names exactly as the base does', () => {
    expectGolden('credentials/host-codex-home', {
      unset: hostCodexHome(undefined, HOME) ?? null,
      empty: hostCodexHome('  ', HOME) ?? null,
      absolute: hostCodexHome('/srv/codex/../codex-home', HOME) ?? null,
      relative: hostCodexHome('relative/codex', HOME) ?? null,
      signInNames: Object.fromEntries(
        ['auth.json', 'AUTH.JSON', '.credentials.json', '.Credentials.JSON', 'config.toml', 'settings.json'].map(
          name => [name, isSignInName(name)],
        ),
      ),
    });
  });

  it('should read the organisation type of the login a launch spends exactly as the base does: Claude reads it, Codex never does', async () => {
    // A fake Logins port (no real Logins, no host file): what it names for a kept login, and the stored view of each login id.
    const stores: readonly LoginLaunchStore[] = [
      { id: 'claude-kept-typed', variables: {}, organizationType: 'claude_enterprise' },
      { id: 'claude-kept-untyped', variables: {} },
    ];
    const views: Readonly<Record<string, { store: string; harness: string }>> = {
      'claude-kept-typed': { store: 'ferretry', harness: 'claude-code' },
      'claude-kept-untyped': { store: 'ferretry', harness: 'claude-code' },
      'claude-host': { store: 'host', harness: 'claude-code' },
      'claude-env': { store: 'environment', harness: 'claude-code' },
      'codex-host': { store: 'host', harness: 'codex' },
    };
    const logins = { launchStores: async () => stores, get: async (id: string) => views[id] } as unknown as Pick<
      LoginsApi,
      'launchStores' | 'get'
    >;
    const answers: Record<string, unknown> = {};
    for (const login of [...Object.keys(views), 'unknown-login']) {
      for (const hostFile of ['claude_max', undefined] as const) {
        let hostFileReads = 0;
        const type = await loginOrganizationType(
          logins,
          async () => {
            hostFileReads++;
            return hostFile;
          },
          login,
          kits,
        );
        answers[`${login} (host file says ${hostFile ?? 'nothing'})`] = { type: type ?? null, hostFileReads };
      }
    }
    expectGolden('credentials/organization-type', {
      answers,
      accountDocument: {
        typed: organizationTypeOfAccountDocument('{"oauthAccount":{"organizationType":"claude_max"}}') ?? null,
        emptyType: organizationTypeOfAccountDocument('{"oauthAccount":{"organizationType":""}}') ?? null,
        notAString: organizationTypeOfAccountDocument('{"oauthAccount":{"organizationType":3}}') ?? null,
        noAccount: organizationTypeOfAccountDocument('{}') ?? null,
        notJson: organizationTypeOfAccountDocument('not json') ?? null,
        absent: organizationTypeOfAccountDocument(undefined) ?? null,
      },
    });
  });

  it('should refuse a third harness by name', () => {
    expectGolden('credentials/third-key', {
      kept: outcome(() => resolveCredentialStore('x', { harness: THIRD_KEY, store: 'ferretry' } as never, PATHS, kits)),
      host: outcome(() => resolveCredentialStore('x', { harness: THIRD_KEY, store: 'host' } as never, PATHS, kits)),
      launchEnvironment: outcome(() =>
        credentialLaunchEnvironment({ harness: THIRD_KEY, store: 'host', secureStorage: '' } as never, kits),
      ),
    });
  });
});
