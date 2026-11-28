/**
 * The catalogue's launch state reads the SAME runtime-wide kit refusal the account plan does (E-276 PR 13): a runtime whose
 * harness kit is absent, or gives no launch line (or, for Claude, no command or home variable), shows
 * `launch.available = false` with `<harness> is not supported here` — BEFORE the install check, Auto support and the login
 * status, so it never says "Sign in to launch" and never `available: true`. A whole kit is unchanged, and the other harness
 * is unaffected.
 */
import { describe, expect, it } from 'bun:test';
import type { HarnessKind } from '../../../daemon/lib/harness-kind.ts';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { type CatalogFacts, runtimeCatalog } from '../../../daemon/lib/service/catalog.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const MODEL = parseAccountModel({
  version: 1,
  machine: { agentPermissions: 'auto' },
  credentials: {
    'claude-env': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:SYNTH_KEY}' } },
    'codex-env': { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: '${secret:SYNTH_OTHER}' } },
  },
  components: {
    modelSets: {
      claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
      codex: { models: ['gpt-6'], default: 'gpt-6' },
    },
  },
  profiles: { default: { layers: ['modelSets/claude', 'modelSets/codex'] } },
  runtimes: {
    'claude-env': { credential: 'claude-env', profile: 'default' },
    'codex-env': { credential: 'codex-env', profile: 'default' },
  },
});

const claude = REAL_KITS.get('claude') as RuntimesHarnessKit;
const codex = REAL_KITS.get('codex') as RuntimesHarnessKit;

const facts = (kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit>, more: Partial<CatalogFacts> = {}): CatalogFacts => ({
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/opt/harness/bin/claude', codex: '/opt/harness/bin/codex' },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
  kits,
  ...more,
});

const launchOf = (name: string, read: CatalogFacts) =>
  runtimeCatalog(MODEL, read).runtimes.find(runtime => runtime.name === name)?.launch;

const withClaude = (kit: RuntimesHarnessKit | undefined): ReadonlyMap<HarnessKind, RuntimesHarnessKit> =>
  new Map([...(kit === undefined ? [] : [['claude', kit] as const]), ['codex', codex] as const]);
const withCodex = (kit: RuntimesHarnessKit | undefined): ReadonlyMap<HarnessKind, RuntimesHarnessKit> =>
  new Map([['claude', claude] as const, ...(kit === undefined ? [] : [['codex', kit] as const])]);

const CLAUDE_KITS = [
  ['no kit', undefined],
  ['no command', { ...claude, command: undefined } as RuntimesHarnessKit],
  ['no home variable', { ...claude, homeEnv: undefined } as RuntimesHarnessKit],
  ['no launch line', { ...claude, wrapper: undefined } as RuntimesHarnessKit],
] as const;
const CODEX_KITS = [
  ['no kit', undefined],
  ['no launch line', { ...codex, wrapper: undefined } as RuntimesHarnessKit],
  ['no runtime extras', { ...codex, runtimeExtras: undefined } as RuntimesHarnessKit],
  ['no fixed layer', { ...codex, fixedLayer: undefined } as RuntimesHarnessKit],
] as const;

const SITUATIONS: readonly (readonly [string, Partial<CatalogFacts>])[] = [
  ['the tool installed and Auto supported', {}],
  [
    'a stored login that needs sign-in',
    { credentialStatus: { 'claude-env': 'needs_sign_in', 'codex-env': 'needs_sign_in' } },
  ],
  ['the tool not installed', { tools: { claude: undefined, codex: undefined } }],
  ['Auto not supported', { acceptsAutoPermissionMode: false }],
];

describe('the catalogue launch state with a missing or partial kit', () => {
  for (const [label, kit] of CLAUDE_KITS) {
    for (const [situation, more] of SITUATIONS) {
      it(`should refuse Claude with ${label}, with ${situation}, as the one runtime-wide reason`, () => {
        expect(launchOf('claude-env', facts(withClaude(kit), more))).toEqual({
          available: false,
          reason: 'claude-code is not supported here',
        });
      });
    }
  }

  for (const [label, kit] of CODEX_KITS) {
    for (const [situation, more] of SITUATIONS) {
      it(`should refuse Codex with ${label}, with ${situation}, as the one runtime-wide reason`, () => {
        expect(launchOf('codex-env', facts(withCodex(kit), more))).toEqual({
          available: false,
          reason: 'codex is not supported here',
        });
      });
    }
  }

  it('should leave the other harness alone when one kit is missing', () => {
    expect(launchOf('codex-env', facts(withClaude(undefined)))).toEqual({ available: true });
    expect(launchOf('claude-env', facts(withCodex(undefined)))).toEqual({ available: true });
  });

  it('should leave a whole kit unchanged: installed, Auto supported is available; not installed and needing sign-in keep their words', () => {
    expect(launchOf('claude-env', facts(REAL_KITS))).toEqual({ available: true });
    expect(launchOf('claude-env', facts(REAL_KITS, { tools: { claude: undefined, codex: undefined } }))).toEqual({
      available: false,
      reason: 'Install Claude Code to launch',
    });
    expect(launchOf('claude-env', facts(REAL_KITS, { credentialStatus: { 'claude-env': 'needs_sign_in' } }))).toEqual({
      available: false,
      reason: 'Sign in to launch',
    });
    expect(launchOf('claude-env', facts(REAL_KITS, { acceptsAutoPermissionMode: false }))?.available).toBe(false);
  });
});
