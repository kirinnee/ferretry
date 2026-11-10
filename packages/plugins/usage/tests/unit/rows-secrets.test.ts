import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AuthorizedOutcome, CredentialPlacement, OutboundHttpRequest } from '@ferretry/core-vault/contract';
import should from 'should';
import { bannedIn } from '../../../../../scripts/validate/banned-globals.ts';
import { scanSource } from '../../../../../scripts/validate/no-sync-io.ts';
import {
  BudgetStandingSchema,
  ProviderQuotaReadingSchema,
  UsageAccountViewSchema,
  UsageFeedViewSchema,
} from '../../contract/index.ts';
import { usageProbeUrls } from '../../daemon/lib/usage/probe-origin.ts';
import { planProviderQuota } from '../../daemon/lib/usage/provider-quota/plan.ts';
import { ProviderQuotaService } from '../../daemon/lib/usage/provider-quota/service.ts';
import { NOW_MS, ZAI_QUOTA } from './usage/provider-quota/fixtures.ts';
import { login as makeLogin, preset } from './usage/provider-quota/logins.ts';

/**
 * The sign-in rows (S175–S178) in Usage's own suite, each driving Usage's own enforcer:
 *
 * - S175 and S178 drive the quota reader (`ProviderQuotaService`, `planProviderQuota`) and the probe-origin rule
 *   (`usageProbeUrls`): what Usage sends and where it may send it.
 * - S176 and S177 are LINT TESTS. By design the worker sandbox rests on the repository's own lints (`banned-globals`,
 *   `fetch-binding`, `no-sync-io`), so each test feeds those lints a fixture of the code a worker bundle must never
 *   contain and asserts it is refused, then asserts Usage's real source passes the same lints. `fetch-binding` scans
 *   a package's browser (`app/`) half only; the daemon half's fetch ban is `banned-globals`.
 *
 * (The ids S175–S178 were `it.skip` lines in rows.test.ts, waiting on the Claude/Codex sign-in read; they now live
 * here, driving what Usage owns today — the environment-key quota read through Logins' `authorizeFetch` and the
 * probe-origin rule.)
 *
 * What these tests do NOT prove: the housekeeping worker program, its message protocol and its bundle diet belong to
 * Logins and are not ported (ports-pending.json), so there is no Usage worker bundle to build and inspect. The
 * lint tests prove the rule a worker would be held to, not a built bundle.
 */

/** A key value planted on the Vault's side of the world; nothing Usage holds, sends or returns may contain it. */
const KEY_VALUE = 'fake-pw-000-planted-key-value';

const USAGE_ROOT = join(import.meta.dir, '..', '..');
const REPO_ROOT = join(USAGE_ROOT, '..', '..', '..');
const FETCH_BINDING = join(REPO_ROOT, 'scripts', 'validate', 'fetch-binding.sh');

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
  readonly sent: Sent[] = [];
  /** What the Vault put on the wire: the one place the key is. */
  readonly wire: string[] = [];
  constructor(private readonly outcome: () => Promise<AuthorizedOutcome>) {}
  async send(
    loginId: string,
    variable: string,
    hosts: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome> {
    this.sent.push({ loginId, variable, hosts, request, placement });
    this.wire.push(`authorization: Bearer ${KEY_VALUE}`);
    return await this.outcome();
  }
}

const answering = (): Promise<AuthorizedOutcome> => Promise.resolve({ kind: 'completion', payload: ZAI_QUOTA });

const serviceOver = (vault: VaultSide, logins = [GLM]): ProviderQuotaService =>
  new ProviderQuotaService({ logins: async () => logins, authorizer: vault, clock: { nowMs: () => NOW_MS } });

const typeFilesUnder = (root: string, glob: string): readonly { readonly file: string; readonly text: string }[] =>
  [...new Bun.Glob(glob).scanSync({ cwd: root })].sort().map(path => ({
    file: join(root, path),
    text: readFileSync(join(root, path), 'utf8'),
  }));

const daemonFiles = (): readonly { readonly file: string; readonly text: string }[] =>
  typeFilesUnder(join(USAGE_ROOT, 'daemon'), '**/*.ts');
const appFiles = (): readonly { readonly file: string; readonly text: string }[] =>
  typeFilesUnder(join(USAGE_ROOT, 'app'), '**/*.{ts,tsx}');

describe('S175 S178 the sign-in is read through Logins and goes only where it belongs', () => {
  it('S175 a quota is read through the Vault’s authorizeFetch: Usage sends no token, holds none and returns none', async () => {
    // Arrange
    const vault = new VaultSide(answering);
    const service = serviceOver(vault);

    // Act
    await service.watch();
    await service.watch();

    // Assert — Usage named a login, the variable that carries its key and the provider's host. The token is placed on
    // the wire by the Vault as ONE header (a single placement) and Usage's request carries no credential of its own.
    should(vault.sent.map(call => [call.loginId, call.variable, call.hosts])).deepEqual([
      ['glm', 'ANTHROPIC_AUTH_TOKEN', ['api.z.ai']],
    ]);
    should(vault.sent[0]?.placement).deepEqual({ header: 'authorization' });
    const headers = Object.keys(vault.sent[0]?.request.headers ?? {}).map(name => name.toLowerCase());
    should(headers).not.containEql('authorization');
    should(JSON.stringify(vault.sent).includes(KEY_VALUE)).be.false();
    // The key WAS placed (so the absence above can fail): it is on the Vault's wire and nowhere Usage looks.
    should(vault.wire.join('\n').includes(KEY_VALUE)).be.true();
    // Dropped within one job: nothing Usage keeps afterwards (its reading) carries it, and the
    // second watch within the minute made no second read.
    should(vault.sent).have.length(1);
    should(JSON.stringify(service.peek('glm')).includes(KEY_VALUE)).be.false();
    // And the daemon half reaches the Vault in one place only: Logins' `authorizeFetch`, never a store or a read.
    const vaultCalls = daemonFiles().flatMap(({ file, text }) =>
      [...text.matchAll(/vault\.(\w+)\(/gu)].map(match => `${relative(USAGE_ROOT, file)}:${match[1]}`),
    );
    should(vaultCalls).deepEqual([]);
  });

  it('S178 a key goes only to its provider or a loopback FY_USAGE_PROBE_ORIGIN; any other origin is refused', () => {
    // The two free reads: a plain loopback origin moves them, every other origin leaves them at the providers.
    should(usageProbeUrls('http://127.0.0.1:43123')).deepEqual({
      anthropic: 'http://127.0.0.1:43123/api/oauth/usage',
      codex: 'http://127.0.0.1:43123/backend-api/wham/usage',
    });
    for (const origin of [
      'http://usage.example.com',
      'http://10.0.0.2:8080',
      'http://127.0.0.1.example.com',
      'http://127.0.0.1:8080/proxy',
      'http://127.0.0.1:8080/?to=elsewhere',
      'http://user:pass@127.0.0.1:8080',
      'ftp://127.0.0.1',
    ])
      should(usageProbeUrls(origin)).be.undefined();

    // The provider-quota reads: a machine preset that would send a login's key to a host the login does not send to
    // is refused before anything is sent.
    const stranger = makeLogin(
      'oa',
      {
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://api.openai.com/v1', ANTHROPIC_API_KEY: '${secret:OPENAI}' },
      },
      { ...preset('deepseek'), origin: 'file', test: { kind: 'none', reason: 'none' } },
    );
    should(planProviderQuota(stranger)).deepEqual({
      reason:
        'Reading this quota would send the key to api.deepseek.com, which is not where this login sends it, so it is not read.',
    });
  });

  it('S178 a refused provider read sends nothing at all through the Vault', async () => {
    // Arrange — the same stranger login, driven through the service rather than the planner.
    const stranger = makeLogin(
      'oa',
      {
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://api.openai.com/v1', ANTHROPIC_API_KEY: '${secret:OPENAI}' },
      },
      { ...preset('deepseek'), origin: 'file', test: { kind: 'none', reason: 'none' } },
    );
    const vault = new VaultSide(answering);

    // Act
    await serviceOver(vault, [stranger]).watch();

    // Assert
    should(vault.sent).deepEqual([]);
    should(vault.wire).deepEqual([]);
  });
});

/** Where each lint fixture is planted; removed after the file. */
let scratch = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'usage-worker-lints-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let planted = 0;
/** One fixture file in the scratch folder, as a worker bundle's source would be. */
const plant = (text: string): string => {
  const file = join(scratch, `worker-fixture-${String(planted++)}.ts`);
  writeFileSync(file, text);
  return file;
};

/** What `banned-globals` says of a fixture, as the set of banned things it names. */
const bannedNames = (text: string): readonly string[] =>
  bannedIn(plant(text), 'worker-fixture.ts').map(finding => finding.message.split(': ')[0] ?? '');

/** The environment a child sees, without the git variables a commit hook would otherwise leak into a scratch repo. */
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined && !entry[0].startsWith('GIT_');
    }),
  );

/** Runs `fetch-binding.sh` from `cwd`; the script scans the git repository that contains it. */
const fetchBinding = (cwd: string): { readonly code: number; readonly stderr: string; readonly stdout: string } => {
  const ran = Bun.spawnSync(['bash', FETCH_BINDING], { cwd, env: cleanEnv(), stdout: 'pipe', stderr: 'pipe' });
  return { code: ran.exitCode, stderr: ran.stderr.toString(), stdout: ran.stdout.toString() };
};

/** A scratch git repository holding one browser-half file of Usage, as `fetch-binding` finds browser code. */
const browserRepo = (name: string, source: string): string => {
  const repo = join(scratch, name);
  mkdirSync(join(repo, 'packages', 'plugins', 'usage', 'app'), { recursive: true });
  writeFileSync(join(repo, 'packages', 'plugins', 'usage', 'app', 'worker-fixture.ts'), source);
  const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: repo, env: cleanEnv() });
  should(init.exitCode).equal(0);
  return repo;
};

const WORKER_TOKEN_FIELD = /token|secret|password|credential|digest|apikey|api_key|bearer/iu;

describe('S176 S177 the worker sandbox rests on the lints: they refuse, and Usage’s own source passes', () => {
  it('S176 a worker that reaches the network or the world around the kernel ports is refused, and nothing crosses back but facts', async () => {
    // banned-globals refuses the ways a worker could carry a token out of its job: the network, the environment,
    // the file system, a child process, a timer that outlives the job.
    const refused = bannedNames(
      [
        `import { readFileSync } from 'node:fs';`,
        `import { spawn } from 'node:child_process';`,
        `export const a = await fetch('https://collector.example/usage');`,
        `export const b = process.env.SIGN_IN_TOKEN;`,
        `export const c = Bun.file('/credentials');`,
        `setTimeout(() => {}, 1);`,
        `export { readFileSync, spawn };`,
      ].join('\n'),
    );
    for (const what of [
      'imports node:fs',
      'imports node:child_process',
      'fetch',
      'process.env',
      'Bun.file',
      'setTimeout',
    ])
      should(refused).containEql(what);

    // fetch-binding refuses a stored `fetch` and a direct network call in browser code, in a scratch repository.
    const stored = fetchBinding(browserRepo('stored', 'export const network = fetch;\n'));
    should(stored.code).equal(1);
    should(stored.stderr).containEql('an unbound fetch builtin is used as a value');
    const called = fetchBinding(browserRepo('called', `export const go = () => fetch('https://collector.example');\n`));
    should(called.code).equal(1);
    should(called.stderr).containEql('a direct network call in browser code skips the daemon client');

    // The real source passes: no Usage file the lint covers names any banned thing, and the repository's own run of
    // `fetch-binding` (which scans Usage's app half) is clean.
    const dirty = [...daemonFiles(), ...appFiles()].flatMap(({ file }) =>
      bannedIn(file, relative(REPO_ROOT, file), file.includes('/app/')).map(f => `${f.where} ${f.message}`),
    );
    should(dirty).deepEqual([]);
    const real = fetchBinding(REPO_ROOT);
    should([real.code, real.stderr]).deepEqual([0, '']);

    // Only facts cross back: no view Usage returns has a field that could carry a token, and a reply that tried to
    // is refused or stripped — the protocol has no token field.
    for (const shape of [
      ProviderQuotaReadingSchema.shape,
      UsageAccountViewSchema.shape,
      UsageFeedViewSchema.shape,
      BudgetStandingSchema.shape,
    ])
      should(Object.keys(shape).filter(key => WORKER_TOKEN_FIELD.test(key))).deepEqual([]);
    should(
      JSON.stringify(UsageAccountViewSchema.parse({ agent: 'glm', accessToken: KEY_VALUE })).includes(KEY_VALUE),
    ).be.false();

    // A failed job is answered with a fixed word, never the caught error: a Vault that throws while quoting the key
    // leaves a reading that says the fixed unreachable word and carries none of the error.
    const failing = new VaultSide(() => Promise.reject(new Error(`socket closed while sending Bearer ${KEY_VALUE}`)));
    const service = serviceOver(failing);
    await service.watch();
    const reading = ProviderQuotaReadingSchema.parse(service.peek('glm'));
    should(JSON.stringify(reading).includes(KEY_VALUE)).be.false();
    should(JSON.stringify(reading).includes('socket closed')).be.false();
  });

  it('S177 a worker that blocks on a file call or binds a vault-side file API is refused, and Usage’s own source holds no vault, store or redactor', () => {
    // no-sync-io counts every blocking file function a daemon-half file uses and refuses a rebinding outright.
    const blocking = scanSource(
      'worker-fixture.ts',
      [
        `import { readFileSync, statSync } from 'node:fs';`,
        `export const secret = readFileSync('/sealed/credentials');`,
        `export const size = statSync('/sealed/credentials').size;`,
      ].join('\n'),
    );
    should(blocking.uses.map(use => use.name)).deepEqual(['readFileSync', 'statSync']);
    const aliased = scanSource('worker-fixture.ts', `import { readFileSync as read } from 'node:fs';\nread('/x');\n`);
    should(aliased.aliases.length).equal(1);

    // banned-globals refuses the file-system and child-process modules the vault's store and redactor are built on.
    const refused = bannedNames(
      `import * as fs from 'node:fs/promises';\nimport { exec } from 'child_process';\nexport { fs, exec };\n`,
    );
    should(refused).containEql('imports node:fs/promises');
    should(refused).containEql('imports child_process');

    // The real source passes: no blocking file call, no alias, in any Usage daemon file (it has no ledger line).
    const real = daemonFiles().flatMap(({ file, text }) => {
      const scan = scanSource(relative(REPO_ROOT, file), text);
      return [
        ...(scan.unparsable === undefined ? [] : [`${file}: unparsable`]),
        ...scan.uses.map(use => `${relative(USAGE_ROOT, file)}:${String(use.line)} ${use.name}`),
        ...scan.aliases.map(alias => `${relative(USAGE_ROOT, file)}:${String(alias.line)} ${alias.text}`),
      ];
    });
    should(real).deepEqual([]);

    // And its imports are the Vault's CONTRACT alone; no vault implementation, store, sealed document or redactor.
    const imports = [...daemonFiles(), ...appFiles()].flatMap(({ file, text }) =>
      [...text.matchAll(/from '(@ferretry\/[^']+)'/gu)].map(match => ({ file, from: match[1] ?? '' })),
    );
    should(
      imports.filter(entry => entry.from.includes('core-vault') && entry.from !== '@ferretry/core-vault/contract'),
    ).deepEqual([]);
    const text = daemonFiles()
      .map(source => source.text)
      .join('\n');
    should(/\bSecretVault\b|\bRedactionScope\b|\bredact(or|ion)\b|SecretStore|SealedDocuments/iu.test(text)).be.false();
  });
});
