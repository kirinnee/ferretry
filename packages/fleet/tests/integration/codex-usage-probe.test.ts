/**
 * The Codex free usage read against a scripted transport. No network, no real credential: the fetch
 * and the store are seams. What matters most here is what is NOT sent and what is NOT concluded — the
 * request carries exactly a bearer and an account id, and no answer is ever login evidence.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { QuotaFetch, QuotaRequest, StoredMaterialSource } from '../../src/adapters/anthropic-usage-probe.ts';
import { CODEX_USAGE_URL, CodexUsageProbe } from '../../src/adapters/codex-usage-probe.ts';
import type { CodexStoreResolution } from '../../src/lib/account/credentials.ts';
import type { CredentialMaterial } from '../../src/lib/identity.ts';

const NOW = 1_800_000_000_000;
const TOKEN = 'placeholder-codex-access';
const ACCOUNT = 'placeholder-account-id';

const resolution: CodexStoreResolution = {
  harness: 'codex',
  store: 'ferretry',
  canonicalFile: '/fleet/credentials/codex-work/auth.json',
  ownedDirectory: '/fleet/credentials/codex-work',
};

const stored = (material: CredentialMaterial): StoredMaterialSource => ({
  storedMaterial: () => Promise.resolve(material),
});

const signedIn = stored({
  outcome: 'found',
  blob: JSON.stringify({ tokens: { access_token: TOKEN, refresh_token: 'r', account_id: ACCOUNT } }),
});

interface Reply {
  readonly status?: number;
  readonly text?: string;
  readonly truncated?: boolean;
  readonly throws?: Error;
}

function transport(reply: Reply): { fetch: QuotaFetch; requests: QuotaRequest[] } {
  const requests: QuotaRequest[] = [];
  const fetch: QuotaFetch = request => {
    requests.push(request);
    if (reply.throws !== undefined) return Promise.reject(reply.throws);
    const status = reply.status ?? 200;
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      headerNames: [],
      header: () => null,
      body: { bytes: new TextEncoder().encode(reply.text ?? ''), truncated: reply.truncated === true },
    });
  };
  return { fetch, requests };
}

const usageBody = JSON.stringify({
  plan_type: 'plus',
  rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 42, reset_at: 1_800_003_600 },
    secondary_window: { used_percent: 9, reset_after_seconds: 86_400 },
  },
});

const probe = (fetch: QuotaFetch, source: StoredMaterialSource = signedIn) =>
  new CodexUsageProbe({ fetch, stored: source, now: () => NOW });

describe('CodexUsageProbe', () => {
  it('should read both windows with exactly a bearer and an account id, and conclude nothing about the login', async () => {
    // Arrange
    const { fetch, requests } = transport({ text: usageBody });

    // Act
    const actual = await probe(fetch).probeCredential(resolution);

    // Assert — no client impersonation: no originator, no OpenAI-Beta, nothing but the two headers.
    should(requests).have.length(1);
    should(requests[0]?.url).equal(CODEX_USAGE_URL);
    should(requests[0]?.method).equal('GET');
    should(requests[0]?.headers).deepEqual({ Authorization: `Bearer ${TOKEN}`, 'ChatGPT-Account-Id': ACCOUNT });
    should(requests[0]?.timeoutMs).equal(20_000);
    should(actual).deepEqual({
      provider: 'openai',
      usageBased: true,
      ok: true,
      shortWindow: { usedPercent: 42, resetAt: 1_800_003_600_000 },
      longWindow: { usedPercent: 9, resetAt: NOW + 86_400_000 },
      atLimit: false,
    });
    should(actual).not.have.property('credentialSignal');
  });

  it('should carry the provider at-limit flag and a configured deadline', async () => {
    // Arrange
    const { fetch, requests } = transport({
      text: JSON.stringify({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100 } } }),
    });

    // Act
    const actual = await new CodexUsageProbe({ fetch, stored: signedIn, now: () => NOW, timeoutMs: 5 }).probeCredential(
      resolution,
    );

    // Assert
    should(requests[0]?.timeoutMs).equal(5);
    should(actual.atLimit).be.true();
    should(actual).not.have.property('longWindow');
  });

  const failures: readonly [string, Reply, string][] = [
    ['a non-2xx status', { status: 401, text: '{}' }, 'the Codex usage endpoint answered HTTP 401'],
    [
      'a truncated body',
      { text: usageBody, truncated: true },
      'the Codex usage endpoint answered more than this read keeps',
    ],
    ['unreadable JSON', { text: '<html>' }, 'the Codex usage read failed'],
    ['a body with no usage', { text: '{"rate_limit":{}}' }, 'the Codex usage endpoint carried no readable usage'],
    [
      'a timeout',
      { throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
      'the Codex usage read timed out',
    ],
    ['a transport failure', { throws: new Error(`connect refused ${TOKEN}`) }, 'the Codex usage read failed'],
  ];
  for (const [what, reply, error] of failures) {
    it(`should report ${what} as a failed reading with no login verdict`, async () => {
      // Arrange
      const { fetch } = transport(reply);

      // Act
      const actual = await probe(fetch).probeCredential(resolution);

      // Assert — and the token never reaches the sentence.
      should(actual.ok).be.false();
      should(actual.error).equal(error);
      should(actual.error).not.containEql(TOKEN);
      should(actual).not.have.property('credentialSignal');
    });
  }

  const unusable: readonly [string, CredentialMaterial][] = [
    ['no file', { outcome: 'absent' }],
    ['an unreadable file', { outcome: 'unreadable', reason: 'denied' }],
    ['a file that is not JSON', { outcome: 'found', blob: 'nope' }],
    ['no account id', { outcome: 'found', blob: JSON.stringify({ tokens: { access_token: TOKEN } }) }],
    ['no access token', { outcome: 'found', blob: JSON.stringify({ tokens: { account_id: ACCOUNT } }) }],
  ];
  for (const [what, material] of unusable) {
    it(`should ask nobody when the credential has ${what}`, async () => {
      // Arrange
      const { fetch, requests } = transport({ text: usageBody });

      // Act
      const actual = await probe(fetch, stored(material)).probeCredential(resolution);

      // Assert
      should(requests).be.empty();
      should(actual.ok).be.false();
      should(actual).not.have.property('credentialSignal');
    });
  }

  it('should decline a Claude credential without asking anybody', async () => {
    // Arrange
    const { fetch, requests } = transport({ text: usageBody });

    // Act
    const actual = await probe(fetch).probeCredential({
      harness: 'claude',
      store: 'host',
      secureStorage: '',
      storageDirectory: '/home/someone/.claude',
      credentialFile: '/home/someone/.claude/.credentials.json',
    });

    // Assert
    should(requests).be.empty();
    should(actual.usageBased).be.false();
    should(actual).not.have.property('credentialSignal');
  });
});
