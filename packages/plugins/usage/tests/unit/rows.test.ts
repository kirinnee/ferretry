import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AuthorizedOutcome, CredentialPlacement, OutboundHttpRequest } from '@ferretry/core-vault/contract';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import {
  BudgetStandingSchema,
  ProviderQuotaReadingSchema,
  UsageAccountViewSchema,
  UsageFeedViewSchema,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';
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
  readonly loginId: string;
  readonly variable: string;
  readonly hosts: readonly string[];
  readonly request: OutboundHttpRequest;
  readonly placement: CredentialPlacement | undefined;
}

/** The Vault's `authorizeFetch`, faked: it alone knows the key, and it answers with the provider's reply only. */
class VaultSide {
  /** What Usage handed the Vault. */
  readonly sent: Sent[] = [];
  /** What the Vault put on the wire: the one place the key is, as the real Vault places it. */
  readonly wire: string[] = [];
  async send(
    loginId: string,
    variable: string,
    hosts: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome> {
    this.sent.push({ loginId, variable, hosts, request, placement });
    this.wire.push(`authorization: Bearer ${KEY_VALUE}`);
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

/**
 * THE SIGN-IN USAGE READ IS NOT HERE YET, SO THE FOUR ROWS BELOW ARE PENDING, NOT PASSING.
 *
 * S175–S178 are about the Claude/Codex sign-in read that runs on the housekeeping worker: a token read from its store
 * for one job and sent as one header, a worker protocol with no token field and a fixed word for a failed job, a worker
 * bundle that holds no vault, and a token that goes only to its provider or the loopback FY_USAGE_PROBE_ORIGIN. That
 * read, its worker and its job runner belong to Logins, Vault and Ferrets, which are still pending ports
 * (ports-pending.json); Usage has no caller of it and no seam to exercise it through. A test of a different thing under
 * those ids would pass without proving them, so each row is a skip that names the seam it waits for. What Usage DOES
 * own and prove today (an environment-key quota read through the Vault, a wire with no token field, a daemon half that
 * imports no vault store, the probe-origin rule) is tested below under what it is.
 */
describe('the sign-in token rows (pending ports)', () => {
  it.skip('S175 a sign-in is read only for the usage read on the housekeeping worker and dropped within one job — pending port: the Logins sign-in usage read, the housekeeping job runner (Ferrets) and the Vault sealed read, none bound yet', () => {});
  it.skip('S176 only facts cross back from the worker and a failed job is answered with a fixed word — pending port: the housekeeping worker protocol and job runner', () => {});
  it.skip('S177 the housekeeping worker bundle carries no vault, store or redactor — pending port: the worker bundle build (the housekeeping worker is not ported)', () => {});
  it.skip('S178 a sign-in token goes only to its provider or the loopback FY_USAGE_PROBE_ORIGIN — pending port: the Logins sign-in usage read, which is the production caller of usageProbeUrls', () => {});
});

describe('what Usage proves of secrets today', () => {
  it('a provider quota is read only through the Vault authorizeFetch, so Usage never holds the key', async () => {
    const vault = new VaultSide();
    const service = new ProviderQuotaService({
      logins: async () => [GLM],
      authorizer: vault,
      clock: { nowMs: () => NOW_MS },
    });

    await service.watch();

    // Usage named a LOGIN, the variable that carries its key and a host; no secret name, and the key was never in its
    // hands, on the request or in the reading.
    should(vault.sent.map(call => [call.loginId, call.variable, call.hosts])).deepEqual([
      ['glm', 'ANTHROPIC_AUTH_TOKEN', ['api.z.ai']],
    ]);
    const sentText = JSON.stringify(vault.sent);
    should(sentText.includes(KEY_VALUE)).be.false();
    // The key WAS placed (so the absence above can fail): it is on the Vault's wire and nowhere Usage looks.
    should(vault.wire.join('\n').includes(KEY_VALUE)).be.true();
    should(Object.keys(vault.sent[0]?.request.headers ?? {}).map(name => name.toLowerCase())).not.containEql(
      'authorization',
    );
    const reading = ProviderQuotaReadingSchema.parse(service.peek('glm'));
    should(JSON.stringify(reading).includes(KEY_VALUE)).be.false();
    should(instantFromEpochMs(NOW_MS)).equal(reading.at);

    // And the daemon half makes no Vault call at all: its one spend is Logins' `authorizeFetch`.
    const vaultCalls = daemonSources().flatMap(({ file, text }) =>
      [...text.matchAll(/vault\.(\w+)\(/gu)].map(match => `${file}:${match[1]}`),
    );
    should(vaultCalls).deepEqual([]);
    const loginsSpends = daemonSources().flatMap(({ file, text }) =>
      [...text.matchAll(/logins\.(authorizeFetch)\(/gu)].map(match => `${file}:${match[1]}`),
    );
    should(loginsSpends).deepEqual(['index.ts:authorizeFetch']);
  });

  it('nothing Usage returns carries a token: the wire has no field for one', () => {
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

  it('the daemon half imports no vault store and no redactor: it asks the Vault and never reads', () => {
    const imports = daemonSources().flatMap(({ file, text }) =>
      [...text.matchAll(/from '(@ferretry\/[^']+)'/gu)].map(match => ({ file, from: match[1] ?? '' })),
    );
    const vaultImports = imports.filter(entry => entry.from.includes('core-vault'));
    should(vaultImports.filter(entry => entry.from !== '@ferretry/core-vault/contract')).deepEqual([]);
    const text = daemonSources()
      .map(source => source.text)
      .join('\n');
    should(/\bRedactionScope\b|\bredact(or|ion)\b|SecretStore|sealed|SealedDocuments/iu.test(text)).be.false();
  });

  it('the probe-origin rule (the one S178 will bind) accepts only a plain loopback origin', () => {
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

describe('Usage cannot name a secret', () => {
  it('S12 S62 Usage does not need the Vault: it names a login to Logins, which resolves the key from that login’s own record', () => {
    should(Object.keys(manifest.needs ?? {}).sort()).deepEqual(['conversation', 'ferrets', 'logins']);
    should(Object.values(manifest.needs ?? {}).map(token => token.name)).not.containEql('vault');
    // The one spend the daemon half makes is Logins' `authorizeFetch`, which takes a login id and a variable, not a secret.
    const text = daemonSources()
      .map(source => source.text)
      .join('\n');
    should(text.includes('needs.logins.authorizeFetch(loginId')).be.true();
    should(/\bauthorizeFetch\(\s*(name|secret)/u.test(text)).be.false();
  });
});
