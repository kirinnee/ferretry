/**
 * Provider assertions for the Appendix D secrets rows Logins co-owns (S167, S175–S178). S176 and S177 are proved at the
 * housekeeping worker: the protocol has no field a token could travel in, a failed job is answered with a fixed word, and
 * the worker's real bundle carries no vault, store or redactor. The other assertions use Logins and the Vault: the
 * Vault is the scripted holder and the kernel's `restrictFetch` is the real permission check, so what is proved here is
 * that nothing in Logins can put a value in a result, or a token anywhere but its provider.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchPort } from '@ferretry/kernel/contract';
import { restrictFetch } from '@ferretry/kernel/host';
import {
  ANTHROPIC_USAGE_URL,
  AnthropicUsageProbe,
  quotaFetch,
} from '../../../daemon/adapters/credentials/anthropic-usage-probe.ts';
import { HOUSEKEEPING_WORKER_URL } from '../../../daemon/adapters/credentials/housekeeping-client.ts';
import { answerHousekeeping } from '../../../daemon/adapters/credentials/housekeeping-job.ts';
import type {
  HousekeepingRequest,
  HousekeepingResponse,
} from '../../../daemon/lib/credentials/housekeeping-protocol.ts';
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
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
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

/** The field names a credential's material, or a token taken from it, would be found under. */
type MaterialField =
  | 'blob'
  | 'token'
  | 'accessToken'
  | 'refreshToken'
  | 'access_token'
  | 'refresh_token'
  | 'id_token'
  | 'idToken'
  | 'bearer'
  | 'authorization'
  | 'secret';

/** Every key reachable from `T`, through objects, arrays and unions. */
type DeepKeys<T, Depth extends unknown[] = []> = Depth['length'] extends 8
  ? never
  : T extends readonly (infer Item)[]
    ? DeepKeys<Item, [...Depth, unknown]>
    : T extends object
      ? { [K in keyof T]-?: K | DeepKeys<T[K], [...Depth, unknown]> }[keyof T]
      : never;

/** `true` exactly when no key reachable from `T` is a material field. */
type CarriesNoMaterial<T> = [Extract<DeepKeys<T>, MaterialField>] extends [never] ? true : false;

// Decided by the type checker (`typecheck`), not at run time: a field added to either direction of the protocol, or to a
// fact the worker answers with, that a token could travel in turns this file red before any test runs.
const requests: CarriesNoMaterial<HousekeepingRequest> = true;
const responses: CarriesNoMaterial<HousekeepingResponse> = true;
// The check itself must be able to fail, or it proves nothing.
const canary: CarriesNoMaterial<{ readonly facts: { readonly accessToken: string } }> = false;

describe('S176 only facts cross back from the worker; a failed job is answered with a fixed word, never the caught error', () => {
  test('S176 the protocol has no field a token could travel in, in either direction (type test)', () => {
    expect([requests, responses, canary]).toEqual([true, true, false]);
  });

  test('S176 a job that throws a token comes back as the fixed word, and a read that finds one carries facts only', async () => {
    const tokenFile = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 1_900_000_000_000 } });
    const quoting = {
      lstat: async () => undefined,
      stat: async () => ({}),
      readText: async () => {
        throw new Error(`cannot read ${tokenFile}`);
      },
    };
    const answering = { ...quoting, readText: async () => tokenFile };
    const fetched = recordingFetch();
    const job = (id: number): HousekeepingRequest => ({
      type: 'job',
      id,
      job: { kind: 'credential.active', harness: 'claude', file: 'claude/.credentials.json', nowMs: 1_800_000_000_000 },
    });

    const failed = await answerHousekeeping(() => ({ root: quoting, fetch: fetched.port, clock: realClock }), job(1));
    const read = await answerHousekeeping(() => ({ root: answering, fetch: fetched.port, clock: realClock }), job(2));

    expect(failed).toEqual({ type: 'result', id: 1, ok: false, failure: 'internal' });
    expect(JSON.stringify(failed).includes(TOKEN)).toBe(false);
    expect(fetched.sent.map(sent => sent.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
    expect(JSON.stringify(read).includes(TOKEN)).toBe(false);
  });
});

interface Metafile {
  readonly inputs: Record<string, { readonly imports: readonly { readonly path: string }[] }>;
}

/** Modules the worker must never carry, by what their path or specifier says. */
const FORBIDDEN: readonly [string, RegExp][] = [
  // The Vault's CONTRACT (the secret-reference grammar, a pure function) is the one seam Logins may import; its implementation never.
  ['the secret vault', /packages\/core\/vault\/(?!contract\/)|secret-vault|SecretVault/u],
  ['a secret store or the redactor', /secret-store|redact/u],
  ['the file system or a child process', /^(node:)?(fs|fs\/promises|child_process)$/u],
  ['another plugin', /packages\/plugins\/(?!logins\/)/u],
];

describe('S177 the worker holds no SecretVault; the build fails if its bundle carries the vault, its store or the redactor', () => {
  test('S177 the bundled housekeeping worker carries the sign-in read and nothing of the vault side (diet test)', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'logins-worker-bundle-'));
    try {
      const entry = fileURLToPath(HOUSEKEEPING_WORKER_URL);
      const built = (await Bun.build({ entrypoints: [entry], target: 'bun', outdir, metafile: true } as Parameters<
        typeof Bun.build
      >[0])) as Awaited<ReturnType<typeof Bun.build>> & { readonly metafile: Metafile };
      expect(built.success).toBe(true);
      const modules = Object.entries(built.metafile.inputs).flatMap(([file, input]) => [
        file,
        ...input.imports.map(imported => imported.path),
      ]);

      for (const [, pattern] of FORBIDDEN) expect(modules.filter(module => pattern.test(module))).toEqual([]);
      // The diet is of the real program: the reader, both probes and the kernel's grant client are in it.
      for (const needed of [
        'material-read.ts',
        'anthropic-usage-probe.ts',
        'codex-usage-probe.ts',
        'core/kernel/worker.ts',
      ])
        expect(modules.some(module => module.endsWith(needed))).toBe(true);
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });

  test('S177 the diet can fail: a module list that carries a vault, a store or a file call is refused by it', () => {
    const carried = [
      'packages/core/vault/daemon/lib/secret-store.ts',
      'node:fs',
      'packages/plugins/usage/daemon/index.ts',
      'packages/plugins/logins/daemon/adapters/credentials/material-read.ts',
    ];
    expect(FORBIDDEN.map(([, pattern]) => carried.filter(module => pattern.test(module)).length)).toEqual([1, 1, 1, 1]);
  });
});

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
