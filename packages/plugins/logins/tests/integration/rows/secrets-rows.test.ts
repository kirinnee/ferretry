/**
 * Provider assertions for the Appendix D secrets rows Logins co-owns (S167, S175–S178). Worker guarantees S176/S177
 * remain skipped until the Usage/Logins worker boundary exists. The executable assertions use Logins and the Vault:
 * the Vault is the scripted holder and the kernel's `restrictFetch` is the real permission check, so what is proved
 * here is that nothing in Logins can put a value in a result, or a token anywhere but its provider.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchPort } from '@ferretry/kernel/contract';
import { restrictFetch } from '@ferretry/kernel/host';
import {
  ANTHROPIC_USAGE_URL,
  AnthropicUsageProbe,
  quotaFetch,
} from '../../../daemon/adapters/credentials/anthropic-usage-probe.ts';
import { AuthorizedProviderProbe } from '../../../daemon/adapters/provider-probe/authorized-provider-probe.ts';
import type { CredentialMaterial } from '../../../daemon/lib/shared/identity.ts';
import { ProviderProbeService } from '../../../daemon/lib/provider-probe/service.ts';
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';
import { CredentialSchema } from '../../support/credential.ts';
import { RecordingTransport, ScriptedAuthorizer } from '../../support/fakes.ts';
import { realClock } from '../../support/real-ports.ts';
import { manifestHosts } from '../../support/manifest-hosts.ts';

const SECRET_VALUE = 'sk-live-TESTONLY-0123456789abcdef';
const TOKEN = 'oauth-access-TESTONLY-token';
const REQUEST = { method: 'GET' as const, headers: {}, timeoutMs: 1_000, maxResponseBytes: 1_024 };

const material: CredentialMaterial = {
  outcome: 'found',
  blob: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 1_900_000_000_000 } }),
};

/** A fetch port that records where each request went and answers a canned usage body. */
function recordingFetch(): { readonly port: FetchPort; readonly sent: { url: string; headers: Headers }[] } {
  const sent: { url: string; headers: Headers }[] = [];
  return {
    sent,
    port: {
      request: async (url, init) => {
        sent.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response('{"five_hour":{"utilization":12,"resets_at":null}}', { status: 200 });
      },
    },
  };
}

describe('S167 callers are handed no value; a login Test goes only to the login’s host; plain http only to this machine', () => {
  test('S167 a keyed plan goes through the Vault with the plan’s own hosts and nothing but the outcome comes back', async () => {
    const authorizer = new ScriptedAuthorizer({ kind: 'completion', payload: { data: [] } });
    const transport = new RecordingTransport();
    const probe = new AuthorizedProviderProbe(authorizer, transport);

    const outcome = await probe.probe({
      kind: 'authorized',
      secretName: 'MOONSHOT_API_KEY' as never,
      hosts: ['api.moonshot.ai'],
      spends: 'nothing',
      placement: { header: 'authorization', scheme: 'Bearer' } as never,
      request: { ...REQUEST, url: 'https://api.moonshot.ai/v1/models' },
    });

    expect(authorizer.calls.map(call => call.hosts)).toEqual([['api.moonshot.ai']]);
    expect(transport.sent).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE);
  });

  test('S167 a keyless plan is sent only to this machine, over plain http, and anywhere else is refused unsent', async () => {
    const transport = new RecordingTransport();
    const probe = new AuthorizedProviderProbe(new ScriptedAuthorizer({ kind: 'refused' }), transport);

    const refused = await Promise.all(
      ['http://models.example/api/tags', 'https://127.0.0.1:11434/api/tags'].map(url =>
        probe.probe({ kind: 'local', spends: 'nothing', request: { ...REQUEST, url } }),
      ),
    );
    await probe.probe({
      kind: 'local',
      spends: 'nothing',
      request: { ...REQUEST, url: 'http://127.0.0.1:11434/api/tags' },
    });

    expect(refused).toEqual([{ kind: 'refused' }, { kind: 'refused' }]);
    expect(transport.sent.map(request => request.url)).toEqual(['http://127.0.0.1:11434/api/tags']);
  });

  test('S167 a login Test result names a code and a sentence, and never the key', async () => {
    const service = new ProviderProbeService({
      probe: new AuthorizedProviderProbe(
        new ScriptedAuthorizer({ kind: 'completion', payload: { data: [] } }),
        new RecordingTransport(),
      ),
      clock: { monotonicMs: () => 0, now: () => '2026-10-16T09:00:00.000Z' as never },
    });
    const preset = builtInPresets().find(entry => entry.id === 'deepseek');

    const result = await service.test(
      {
        id: 'ds',
        credential: CredentialSchema.parse({
          harness: 'claude',
          store: 'environment',
          preset: 'deepseek',
          env: { ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}' },
        }),
        preset,
      },
      { allowInference: false },
    );

    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(Object.keys(result)).not.toContain('token');
  });
});

describe('S175 a sign-in is read, never copied: the token is sent as one header and dropped', () => {
  test('S175 the usage read sends the token as the one authorization header and the result carries it nowhere', async () => {
    const fetched = recordingFetch();
    const probe = new AnthropicUsageProbe({ fetch: quotaFetch(fetched.port, realClock) });

    const result = await probe.probeMaterial(material);

    expect(fetched.sent).toHaveLength(1);
    expect(fetched.sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('a failed in-process read is answered with a fixed word, never the caught error', () => {
  test('a transport failure that quotes the token comes back without it (additional S176 assertion)', async () => {
    const failing: FetchPort = {
      request: async () => {
        throw new Error(`socket closed while sending Bearer ${TOKEN}`);
      },
    };
    const probe = new AnthropicUsageProbe({ fetch: quotaFetch(failing, realClock) });

    const result = await probe.probeMaterial(material);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('the Logins source imports only the Vault contract', () => {
  test('no daemon source of Logins imports the Vault’s implementation, only its contract (additional S177 assertion)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          for (const line of readFileSync(path, 'utf8').split('\n')) {
            const from = /from '(@ferretry\/core-vault[^']*)'/u.exec(line)?.[1];
            if (from !== undefined && from !== '@ferretry/core-vault/contract') offenders.push(`${path}: ${from}`);
            if (/SecretVault|secret-store|redactor/iu.test(line) && /\bimport\b/u.test(line))
              offenders.push(`${path}: ${line}`);
          }
        }
      }
    };
    walk(join(import.meta.dir, '../../../daemon'));
    expect(offenders).toEqual([]);
  });
});

// Usage is still a skeleton and Logins has no worker protocol or entrypoint. These rows are not proved by the
// in-process failure assertion or source scan above. Replace these skips at the actual worker boundary when ported.
test.skip('S176 worker protocol type has no token field — worker boundary unported', () => {});
test.skip('S177 actual worker bundle excludes Vault, store and redactor — worker boundary unported', () => {});

describe('S178 the token goes only to its provider; any other origin is refused', () => {
  test('S178 the manifest’s network list admits the provider and refuses an origin it does not name', async () => {
    const fetched = recordingFetch();
    const guarded = restrictFetch('logins', manifestHosts(), fetched.port);

    await guarded.request(ANTHROPIC_USAGE_URL, { headers: { authorization: `Bearer ${TOKEN}` } });
    const stray = await guarded
      .request('https://collector.example/usage', { headers: { authorization: `Bearer ${TOKEN}` } })
      .then(
        () => 'sent',
        () => 'refused',
      );

    expect(fetched.sent.map(request => new URL(request.url).hostname)).toEqual(['api.anthropic.com']);
    expect(stray).toBe('refused');
  });
});
