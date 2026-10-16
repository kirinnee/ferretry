import { describe, it } from 'bun:test';
import should from 'should';
import {
  credentialCodexProvider,
  credentialHalf,
  credentialHalves,
  credentialHarnesses,
  credentialServes,
  credentialVariables,
  type HalvedCredential,
  hasHalves,
} from '../../src/lib/account/halves.ts';

const SIGN_IN: HalvedCredential = { harness: 'claude', store: 'host' };
const LEGACY_ENV: HalvedCredential = {
  harness: 'codex',
  store: 'environment',
  env: { KIMI_API_KEY: '${secret:MOONSHOT_API_KEY}' },
  codexProvider: { id: 'kimi', keyVariable: 'KIMI_API_KEY' },
};
const DUAL: HalvedCredential = {
  harness: 'claude',
  store: 'environment',
  env: { SHARED: 'everyone' },
  claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
  codex: {
    env: { OPENROUTER_API_KEY: '${secret:S}' },
    codexProvider: { id: 'openrouter', keyVariable: 'OPENROUTER_API_KEY' },
  },
};

describe('hasHalves', () => {
  it('should be false for a sign-in, a legacy environment login and an environment login with neither half', () => {
    should(hasHalves(SIGN_IN)).be.false();
    should(hasHalves(LEGACY_ENV)).be.false();
    should(hasHalves({ harness: 'claude', store: 'environment', env: {} })).be.false();
  });

  it('should be true for an environment login naming a claude or a codex half', () => {
    should(hasHalves(DUAL)).be.true();
    should(hasHalves({ harness: 'claude', store: 'environment', claude: {} })).be.true();
    should(hasHalves({ harness: 'codex', store: 'environment', codex: {} })).be.true();
  });
});

describe('credentialHalves', () => {
  it('should give a sign-in one half, its own harness, with an empty env', () => {
    should(credentialHalves(SIGN_IN)).deepEqual({ claude: { env: {} } });
  });

  it('should give a legacy environment login one half carrying its env and codexProvider', () => {
    should(credentialHalves(LEGACY_ENV)).deepEqual({
      codex: {
        env: { KIMI_API_KEY: '${secret:MOONSHOT_API_KEY}' },
        codexProvider: { id: 'kimi', keyVariable: 'KIMI_API_KEY' },
      },
    });
  });

  it('should give a halved login every half with the shared env merged under its own', () => {
    should(credentialHalves(DUAL)).deepEqual({
      claude: { env: { SHARED: 'everyone', ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
      codex: {
        env: { SHARED: 'everyone', OPENROUTER_API_KEY: '${secret:S}' },
        codexProvider: { id: 'openrouter', keyVariable: 'OPENROUTER_API_KEY' },
      },
    });
  });

  it("should let a half's own variable win over the shared one of the same name", () => {
    const credential: HalvedCredential = {
      harness: 'claude',
      store: 'environment',
      env: { NAME: 'shared' },
      claude: { env: { NAME: 'claude-own' } },
    };
    should(credentialHalves(credential).claude?.env).deepEqual({ NAME: 'claude-own' });
  });

  it('should carry no claude half when the login names only codex, and vice versa', () => {
    should(credentialHalves({ harness: 'codex', store: 'environment', codex: { env: {} } })).deepEqual({
      codex: { env: {} },
    });
    should(credentialHalves({ harness: 'claude', store: 'environment', claude: { env: {} } })).deepEqual({
      claude: { env: {} },
    });
  });
});

describe('credentialHarnesses', () => {
  it('should be Claude Code first for a dual login', () => {
    should(credentialHarnesses(DUAL)).deepEqual(['claude', 'codex']);
  });

  it('should be the one half for a sign-in or a legacy environment login', () => {
    should(credentialHarnesses(SIGN_IN)).deepEqual(['claude']);
    should(credentialHarnesses(LEGACY_ENV)).deepEqual(['codex']);
  });
});

describe('credentialServes', () => {
  it('should be true for a half the login drives and false for the other', () => {
    should(credentialServes(DUAL, 'claude')).be.true();
    should(credentialServes(DUAL, 'codex')).be.true();
    should(credentialServes(LEGACY_ENV, 'claude')).be.false();
  });
});

describe('credentialHalf', () => {
  it('should give the asked-for half, or undefined when the login does not drive it', () => {
    should(credentialHalf(DUAL, 'codex')?.codexProvider).deepEqual({
      id: 'openrouter',
      keyVariable: 'OPENROUTER_API_KEY',
    });
    should(credentialHalf(LEGACY_ENV, 'claude')).be.undefined();
  });
});

describe('credentialVariables', () => {
  it("should union every half's variables, a Claude name winning over a Codex one", () => {
    const clash: HalvedCredential = {
      harness: 'claude',
      store: 'environment',
      claude: { env: { ONLY_CLAUDE: 'c', SAME: 'claude-value' } },
      codex: { env: { ONLY_CODEX: 'x', SAME: 'codex-value' } },
    };
    should(credentialVariables(clash)).deepEqual({ ONLY_CLAUDE: 'c', SAME: 'claude-value', ONLY_CODEX: 'x' });
  });

  it('should be the one half’s env for a sign-in or a legacy login', () => {
    should(credentialVariables(SIGN_IN)).deepEqual({});
    should(credentialVariables(LEGACY_ENV)).deepEqual({ KIMI_API_KEY: '${secret:MOONSHOT_API_KEY}' });
  });
});

describe('credentialCodexProvider', () => {
  it("should be the codex half's provider, whichever shape the login is written in", () => {
    should(credentialCodexProvider(DUAL)).deepEqual({ id: 'openrouter', keyVariable: 'OPENROUTER_API_KEY' });
    should(credentialCodexProvider(LEGACY_ENV)).deepEqual({ id: 'kimi', keyVariable: 'KIMI_API_KEY' });
  });

  it('should be undefined for a login with no codex half, or whose codex half has none', () => {
    should(credentialCodexProvider(SIGN_IN)).be.undefined();
    should(
      credentialCodexProvider({ harness: 'claude', store: 'environment', claude: { env: {} }, codex: { env: {} } }),
    ).be.undefined();
  });
});
