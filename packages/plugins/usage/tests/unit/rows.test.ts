import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AuthorizedOutcome, CredentialPlacement, OutboundHttpRequest, SecretName } from '@ferretry/core-vault/contract';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import {
  BudgetStandingSchema,
  ProviderQuotaReadingSchema,
  UsageAccountViewSchema,
  UsageFeedViewSchema,
} from '../../contract/index.ts';
import { usageProbeUrls } from '../../daemon/lib/usage/probe-origin.ts';
import { ProviderQuotaService } from '../../daemon/lib/usage/provider-quota/service.ts';
import { NOW_MS, ZAI_QUOTA } from './usage/provider-quota/fixtures.ts';
import { login as makeLogin, preset } from './usage/provider-quota/logins.ts';

/** A key value the tests plant in the Vault's side of the world; nothing Usage holds may ever contain it. */
const KEY_VALUE = 'sk-planted-key-value-0123456789';

const GLM = makeLogin(
  'glm',
  {
    harness: 'claude',
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
  },
  preset('zai-glm'),
);

interface Sent {
  readonly secret: SecretName;
  readonly hosts: readonly string[];
  readonly request: OutboundHttpRequest;
  readonly placement: CredentialPlacement | undefined;
}

/** The Vault's `authorizeFetch`, faked: it alone knows the key, and it answers with the provider's reply only. */
class VaultSide {
  readonly sent: Sent[] = [];
  async send(
    secret: SecretName,
    hosts: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome> {
    this.sent.push({ secret, hosts, request, placement });
    return { kind: 'completion', payload: ZAI_QUOTA };
  }
}

const daemonSources = (): readonly { readonly file: string; readonly text: string }[] => {
  const root = join(import.meta.dir, '..', '..', 'daemon');
  return [...new Bun.Glob('**/*.ts').scanSync({ cwd: root })].map(path => ({
    file: relative(root, join(root, path)),
    text: readFileSync(join(root, path), 'utf8'),
  }));
};

describe('the secrets rows', () => {
  it('S175 a provider quota is read only through the Vault authorizeFetch, so Usage never holds the key', async () => {
    const vault = new VaultSide();
    const service = new ProviderQuotaService({
      logins: async () => [GLM],
      authorizer: vault,
      clock: { nowMs: () => NOW_MS },
    });

    await service.watch();

    // Usage named a secret and a host; the key was never in its hands, on the request or in the reading.
    should(vault.sent.map(call => [call.secret, call.hosts])).deepEqual([['ZAI_API_KEY', ['api.z.ai']]]);
    const sentText = JSON.stringify(vault.sent);
    should(sentText.includes(KEY_VALUE)).be.false();
    should(Object.keys(vault.sent[0]?.request.headers ?? {}).map(name => name.toLowerCase())).not.containEql(
      'authorization',
    );
    const reading = ProviderQuotaReadingSchema.parse(service.peek('glm'));
    should(JSON.stringify(reading).includes(KEY_VALUE)).be.false();
    should(instantFromEpochMs(NOW_MS)).equal(reading.at);

    // And the only Vault call the daemon half makes is that one.
    const vaultCalls = daemonSources().flatMap(({ file, text }) =>
      [...text.matchAll(/vault\.(\w+)\(/gu)].map(match => `${file}:${match[1]}`),
    );
    should(vaultCalls).deepEqual(['index.ts:authorizeFetch']);
  });

  it('S176 nothing Usage returns carries a token: the wire has no field for one', () => {
    const named = /token|secret|password|credential|digest|apikey|api_key|bearer/iu;
    const shapes = [
      ProviderQuotaReadingSchema.shape,
      UsageAccountViewSchema.shape,
      UsageFeedViewSchema.shape,
      BudgetStandingSchema.shape,
    ];
    for (const shape of shapes) should(Object.keys(shape).filter(key => named.test(key))).deepEqual([]);

    // A reply that tried to carry one is refused (strict) or stripped, never passed on.
    should(
      ProviderQuotaReadingSchema.safeParse({
        source: 'zai-coding-plan',
        via: 'endpoint',
        windows: [],
        exhausted: false,
        unverified: true,
        at: instantFromEpochMs(NOW_MS),
        accessToken: KEY_VALUE,
      }).success,
    ).be.false();
    const stripped = UsageAccountViewSchema.parse({ agent: 'glm', accessToken: KEY_VALUE });
    should(JSON.stringify(stripped).includes(KEY_VALUE)).be.false();

    // The same at the type level: a token field does not exist on the view.
    // @ts-expect-error UsageAccountView has no `accessToken`.
    void stripped.accessToken;
  });

  it('S177 the daemon half imports no vault store and no redactor: it asks the Vault and never reads', () => {
    const imports = daemonSources().flatMap(({ file, text }) =>
      [...text.matchAll(/from '(@ferretry\/[^']+)'/gu)].map(match => ({ file, from: match[1] ?? '' })),
    );
    const vaultImports = imports.filter(entry => entry.from.includes('core-vault'));
    should(vaultImports.filter(entry => entry.from !== '@ferretry/core-vault/contract')).deepEqual([]);
    const text = daemonSources().map(source => source.text).join('\n');
    should(/\bRedactionScope\b|\bredact(or|ion)\b|SecretStore|sealed|SealedDocuments/iu.test(text)).be.false();
  });

  it('S178 the probe origin may move a credential-bearing read only to a loopback origin', () => {
    should(usageProbeUrls('http://127.0.0.1:43123')).deepEqual({
      anthropic: 'http://127.0.0.1:43123/api/oauth/usage',
      codex: 'http://127.0.0.1:43123/backend-api/wham/usage',
    });
    for (const origin of [
      'http://usage.example.com',
      'http://10.0.0.2:8080',
      'http://127.0.0.1.example.com',
      'http://127.0.0.1:8080/proxy',
      'http://user:pass@127.0.0.1:8080',
      'ftp://127.0.0.1',
    ])
      should(usageProbeUrls(origin)).be.undefined();
    should(usageProbeUrls(undefined)).be.undefined();
  });
});
