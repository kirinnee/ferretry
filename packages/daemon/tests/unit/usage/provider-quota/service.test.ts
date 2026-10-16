import { describe, it } from 'bun:test';
import { builtInPresets, CredentialSchema, type ProviderPreset } from '@ferretry/fleet';
import { ProviderQuotaReadingSchema, type SecretName } from '@ferretry/protocol';
import should from 'should';
import type { ProviderQuotaLogin } from '../../../../src/lib/usage/provider-quota/plan.ts';
import {
  monthStartMs,
  PROVIDER_QUOTA_MIN_INTERVAL_MS,
  PROVIDER_QUOTA_NOTES,
  ProviderQuotaService,
  type TranscriptSpend,
  type TranscriptSpendPort,
} from '../../../../src/lib/usage/provider-quota/service.ts';
import type {
  AuthorizedOutcome,
  CredentialPlacement,
  OutboundAuthorizerPort,
  OutboundHttpRequest,
} from '../../../../src/lib/speedups/ports.ts';
import { DEEPSEEK_BALANCE, MINIMAX_LOGIN_FAIL, NOW_MS, ZAI_QUOTA } from './fixtures.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;
const NOW = new Date(NOW_MS).toISOString();

const login = (id: string, presetId: string | undefined, env: Record<string, string>): ProviderQuotaLogin => ({
  id,
  credential: CredentialSchema.parse({
    harness: 'claude',
    store: 'environment',
    ...(presetId === undefined ? {} : { preset: presetId }),
    env,
  }),
  preset: presetId === undefined ? undefined : preset(presetId),
  agents: [`${id}-agent`],
});

const GLM = login('glm', 'zai-glm', {
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
});
const DEEPSEEK = login('ds', 'deepseek', {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
});
const ANTHROPIC = login('api', 'anthropic-api-key', { ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}' });

interface SentCall {
  readonly secretName: SecretName;
  readonly hosts: readonly string[];
  readonly request: OutboundHttpRequest;
  readonly placement: CredentialPlacement | undefined;
}

/** The outbound holder, faked: answers from a script per URL and remembers each call. Never the network. */
class ScriptedAuthorizer implements Pick<OutboundAuthorizerPort, 'send'> {
  readonly calls: SentCall[] = [];
  release: (() => void) | undefined;
  constructor(
    public answer: (url: string) => AuthorizedOutcome | Promise<AuthorizedOutcome> = () => ({
      kind: 'completion',
      payload: ZAI_QUOTA,
    }),
  ) {}
  async send(
    secretName: SecretName,
    hosts: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome> {
    this.calls.push({ secretName, hosts, request, placement });
    return await this.answer(request.url);
  }
}

class FixedSpend implements TranscriptSpendPort {
  readonly asked: [readonly string[], number][] = [];
  constructor(private readonly answer: TranscriptSpend | undefined) {}
  async spend(agents: readonly string[], sinceMs: number): Promise<TranscriptSpend | undefined> {
    this.asked.push([agents, sinceMs]);
    return this.answer;
  }
}

const harness = (
  logins: readonly ProviderQuotaLogin[],
  authorizer = new ScriptedAuthorizer(),
  spend?: TranscriptSpendPort,
) => {
  const clock = { now: NOW_MS };
  const service = new ProviderQuotaService({
    logins: async () => logins,
    authorizer,
    ...(spend === undefined ? {} : { spend }),
    clock: { nowMs: () => clock.now },
  });
  return { service, authorizer, clock };
};

describe('ProviderQuotaService — when it reads', () => {
  it('should read nothing until somebody watches, then read the provider once through the outbound holder', async () => {
    // Arrange
    const { service, authorizer } = harness([GLM]);

    // Act
    const before = service.peek('glm');
    await service.watch();

    // Assert
    should(before).be.undefined();
    should(authorizer.calls.map(call => [call.secretName, call.hosts, call.request.url])).deepEqual([
      ['ZAI_API_KEY', ['api.z.ai'], 'https://api.z.ai/api/monitor/usage/quota/limit'],
    ]);
    const reading = ProviderQuotaReadingSchema.parse(service.peek('glm'));
    should(reading).containDeep({
      source: 'zai-coding-plan',
      via: 'endpoint',
      exhausted: false,
      unverified: true,
      at: NOW,
    });
    should(reading.windows.map(window => window.label)).deepEqual(['5h', 'week', 'tools']);
    should(service.peekAgent('glm-agent')).equal(service.peek('glm'));
    should(service.peekAgent('unknown')).be.undefined();
  });

  it('should read one login at most once a minute however many watch, and share a read in flight', async () => {
    // Arrange
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const authorizer = new ScriptedAuthorizer(async () => {
      await gate;
      return { kind: 'completion', payload: ZAI_QUOTA };
    });
    const { service, clock } = harness([GLM], authorizer);

    // Act
    const first = service.watch();
    const second = service.watch();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    clock.now += PROVIDER_QUOTA_MIN_INTERVAL_MS - 1;
    await service.watch();
    const withinAMinute = authorizer.calls.length;
    clock.now += 1;
    await service.watch();

    // Assert
    should(withinAMinute).equal(1);
    should(authorizer.calls).have.length(2);
  });

  it('should never reject a watch when the logins cannot be listed', async () => {
    // Arrange
    const service = new ProviderQuotaService({
      logins: async () => {
        throw new Error('config unreadable');
      },
      authorizer: new ScriptedAuthorizer(),
      clock: { nowMs: () => NOW_MS },
    });

    // Act & Assert
    await service.watch();
    should(service.peek('glm')).be.undefined();
  });
});

describe('ProviderQuotaService — in which order', () => {
  it('should stamp a balance reading as verified when its provider documents the endpoint', async () => {
    // Arrange
    const { service } = harness(
      [DEEPSEEK],
      new ScriptedAuthorizer(() => ({ kind: 'completion', payload: DEEPSEEK_BALANCE })),
    );

    // Act
    await service.watch();

    // Assert
    should(service.peek('ds')).deepEqual({
      source: 'deepseek-balance',
      via: 'endpoint',
      windows: [],
      balance: { amount: 12.5, currency: 'USD' },
      exhausted: false,
      unverified: false,
      at: NOW,
    });
  });

  it('should fall back to transcript cost this month when the provider refuses the key, and say why', async () => {
    // Arrange
    const spend = new FixedSpend({ usdMicros: 3_250_000, sessions: 3, unpriced: 1 });
    const minimax = login('glm', 'minimax', {
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: '${secret:MINIMAX_API_KEY}',
    });
    const cases: [ProviderQuotaLogin, AuthorizedOutcome][] = [
      [GLM, { kind: 'status', status: 401 }],
      [minimax, { kind: 'completion', payload: MINIMAX_LOGIN_FAIL }],
      [GLM, { kind: 'secret_missing' }],
    ];
    for (const [subject, outcome] of cases) {
      const { service } = harness([subject], new ScriptedAuthorizer(() => outcome), spend);

      // Act
      await service.watch();

      // Assert
      const reading = service.peek('glm');
      should(reading).containDeep({
        via: 'transcript',
        spend: { amountUsd: 3.25, since: new Date(monthStartMs(NOW_MS)).toISOString(), sessions: 3, unpriced: 1 },
        windows: [],
      });
      should([PROVIDER_QUOTA_NOTES.rejected, PROVIDER_QUOTA_NOTES.missing]).containEql(reading?.note);
    }
    should(spend.asked[0]).deepEqual([['glm-agent'], Date.parse('2026-10-01T00:00:00.000Z')]);
  });

  it('should keep the last endpoint reading through a blip, and fall back when there never was one', async () => {
    // Arrange
    let outcome: AuthorizedOutcome = { kind: 'completion', payload: ZAI_QUOTA };
    const { service, clock } = harness([GLM], new ScriptedAuthorizer(() => outcome));
    await service.watch();
    const good = service.peek('glm');
    const blips: AuthorizedOutcome[] = [
      { kind: 'timeout' },
      { kind: 'status', status: 503 },
      { kind: 'unreadable' },
      { kind: 'oversized' },
      { kind: 'completion', payload: { nope: true } },
    ];

    for (const blip of blips) {
      outcome = blip;
      clock.now += PROVIDER_QUOTA_MIN_INTERVAL_MS;

      // Act
      await service.watch();

      // Assert
      should(service.peek('glm')).equal(good);
    }
    const fresh = harness([GLM], new ScriptedAuthorizer(() => ({ kind: 'unreachable' })));
    await fresh.service.watch();
    should(fresh.service.peek('glm')).containDeep({ via: 'unknown', note: PROVIDER_QUOTA_NOTES.unanswered });
    const unreadable = harness([GLM], new ScriptedAuthorizer(() => ({ kind: 'oversized' })));
    await unreadable.service.watch();
    should(unreadable.service.peek('glm')).containDeep({ via: 'unknown', note: PROVIDER_QUOTA_NOTES.unreadable });
  });

  it('should replace an endpoint reading once the provider refuses the key', async () => {
    // Arrange
    let outcome: AuthorizedOutcome = { kind: 'completion', payload: ZAI_QUOTA };
    const { service, clock } = harness([GLM], new ScriptedAuthorizer(() => outcome));
    await service.watch();
    outcome = { kind: 'status', status: 403 };
    clock.now += PROVIDER_QUOTA_MIN_INTERVAL_MS;

    // Act
    await service.watch();

    // Assert
    should(service.peek('glm')).containDeep({ via: 'unknown', note: PROVIDER_QUOTA_NOTES.rejected });
  });

  it('should treat an authorizer that throws as a provider that did not answer', async () => {
    // Arrange
    const { service } = harness(
      [GLM],
      new ScriptedAuthorizer(() => {
        throw new Error('socket closed');
      }),
    );

    // Act
    await service.watch();

    // Assert
    should(service.peek('glm')).containDeep({ via: 'unknown', note: PROVIDER_QUOTA_NOTES.unanswered });
  });

  it('should count a provider with no endpoint from the transcripts, and say "unknown" when nothing was priced', async () => {
    // Arrange
    const priced = harness(
      [ANTHROPIC],
      new ScriptedAuthorizer(),
      new FixedSpend({ usdMicros: 0, sessions: 2, unpriced: 1 }),
    );
    const unpriced = harness(
      [ANTHROPIC],
      new ScriptedAuthorizer(),
      new FixedSpend({ usdMicros: 0, sessions: 2, unpriced: 2 }),
    );
    const nothing = harness([ANTHROPIC], new ScriptedAuthorizer(), new FixedSpend(undefined));
    const noPort = harness([ANTHROPIC]);

    // Act
    await Promise.all([priced, unpriced, nothing, noPort].map(async entry => await entry.service.watch()));

    // Assert
    should(priced.service.peek('api')).containDeep({ source: 'transcript-pricing', via: 'transcript' });
    should(priced.service.peek('api')).not.have.property('note');
    for (const entry of [unpriced, nothing, noPort]) {
      should(entry.service.peek('api')).containDeep({ via: 'unknown', note: PROVIDER_QUOTA_NOTES.nothingPriced });
    }
    should(priced.authorizer.calls).have.length(0);
  });

  it('should say a local model has no quota, and a login without a preset is counted from transcripts', async () => {
    // Arrange
    const ollama: ProviderQuotaLogin = {
      id: 'local',
      credential: CredentialSchema.parse({
        harness: 'codex',
        store: 'environment',
        preset: 'ollama-codex',
        codexProvider: { id: 'ollama' },
      }),
      preset: preset('ollama-codex'),
      agents: [],
    };
    const bare = login('bare', undefined, { ANTHROPIC_API_KEY: '${secret:K}' });
    const { service } = harness(
      [ollama, bare],
      new ScriptedAuthorizer(),
      new FixedSpend({ usdMicros: 1, sessions: 1, unpriced: 0 }),
    );

    // Act
    await service.watch();

    // Assert
    should(service.peek('local')).containDeep({ source: 'none', via: 'unknown', note: PROVIDER_QUOTA_NOTES.local });
    should(service.peek('bare')).containDeep({ source: 'transcript-pricing', via: 'transcript' });
  });

  it('should say why when no endpoint read can be planned, and a spend port that fails counts as none', async () => {
    // Arrange
    const templated = login('t', 'zai-glm', { ANTHROPIC_AUTH_TOKEN: 'Bearer ${secret:ZAI_API_KEY}' });
    const failing: TranscriptSpendPort = {
      spend: async () => {
        throw new Error('index closed');
      },
    };
    const { service, authorizer } = harness([templated], new ScriptedAuthorizer(), failing);

    // Act
    await service.watch();

    // Assert
    should(authorizer.calls).have.length(0);
    should(service.peek('t')?.note).startWith('This login’s key is not a single');
  });
});

describe('monthStartMs', () => {
  it('should be the first instant of the UTC month', () => {
    // Act & Assert
    should(new Date(monthStartMs(NOW_MS)).toISOString()).equal('2026-10-01T00:00:00.000Z');
  });
});
