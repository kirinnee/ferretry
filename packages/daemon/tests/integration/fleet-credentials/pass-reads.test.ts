/**
 * How often one fleet pass reads each credential's store (docs/design/housekeeping-worker.md §4 PR 1).
 *
 * The daemon's own composition, minus the network: two Claude logins and one Codex login in a temporary
 * fleet root, the real platform store (as Linux, and as a Mac whose `security` is a counting fake),
 * the kept facts, the status service, the credentials list and the email reader. A pass is what the
 * timer runs — the feed's settled list and the observation, together — and then a person opens the list.
 *
 * Before PR 1 one idle Claude login cost FOUR store reads a pass (classify, the probe's read, classify
 * again, and the list's), which on a Mac is four `security` processes; a Codex login cost SIX. Now each
 * costs ONE — the free read's own — and the list costs none.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AccountModel,
  type CredentialMaterial,
  CredentialStatusService,
  InMemoryCredentialStatusStore,
  type StoredCredentialResolution,
} from '@ferretry/fleet';
import {
  AnthropicUsageProbe,
  CachedCredentialReads,
  CodexUsageProbe,
  credentialFileStamp,
  MaterialCredentialReads,
  PlatformFleetCredentialStore,
  type QuotaFetch,
} from '@ferretry/fleet/adapters';
import should from 'should';
import { CredentialEmailReader } from '../../../src/adapters/fleet-credentials/credential-facts.ts';
import {
  createFleetCredentialsSubsystem,
  FleetCredentialCatalog,
  type FleetCredentialsService,
} from '../../../src/lib/fleet/credentials-service.ts';

const NOW = 1_786_000_000_000;
const HOUR = 3_600_000;
const INTERVAL = 60_000;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown): string => `${segment({ alg: 'none' })}.${segment(payload)}.sig`;
const claudeBlob = (token: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt: NOW + HOUR } });

const model = {
  version: 2,
  credentials: {
    work: { harness: 'claude', store: 'ferretry' },
    home: { harness: 'claude', store: 'ferretry' },
    cx: { harness: 'codex', store: 'ferretry' },
  },
  runtimes: {},
} as unknown as AccountModel;

/** The usage endpoints, answering every free read. Never the network. */
const fetchOf = (): QuotaFetch => async request => {
  const body = request.url.includes('chatgpt')
    ? { rate_limit: { primary_window: { used_percent: 4 } } }
    : { five_hour: { utilization: 4 } };
  return {
    status: 200,
    ok: true,
    headerNames: ['content-type'],
    header: name => (name === 'content-type' ? 'application/json' : null),
    body: { bytes: new TextEncoder().encode(JSON.stringify(body)), truncated: false },
  };
};

interface Machine {
  readonly credentials: FleetCredentialsService;
  /** Store reads, by credential store. */
  readonly reads: Map<string, number>;
  /** `security` processes. */
  readonly spawns: { count: number };
  clock: number;
}

async function machine(platform: 'linux' | 'darwin'): Promise<Machine> {
  const fleetRoot = await mkdtemp(join(tmpdir(), 'fy-pass-reads-'));
  roots.push(fleetRoot);
  for (const id of ['work', 'home']) {
    await mkdir(join(fleetRoot, 'credentials', id), { recursive: true });
    if (platform === 'linux') await writeFile(join(fleetRoot, 'credentials', id, '.credentials.json'), claudeBlob(id));
  }
  await mkdir(join(fleetRoot, 'credentials', 'cx'), { recursive: true });
  await writeFile(
    join(fleetRoot, 'credentials', 'cx', 'auth.json'),
    JSON.stringify({
      last_refresh: new Date(NOW).toISOString(),
      tokens: {
        access_token: jwt({ exp: (NOW + HOUR) / 1000 }),
        refresh_token: 'refresh-TESTONLY',
        account_id: 'acct',
        id_token: jwt({ email: 'team@example.com' }),
      },
    }),
  );
  const spawns = { count: 0 };
  const store = new PlatformFleetCredentialStore({
    platform,
    command: {
      run: async () => {
        spawns.count += 1;
        return { code: 0, stdout: claudeBlob('keychain-TESTONLY') };
      },
    },
    now: () => NOW,
    keychainAccount: 'person',
  });
  const reads = new Map<string, number>();
  const counted = {
    storedMaterial: async (resolution: StoredCredentialResolution): Promise<CredentialMaterial> => {
      const key = resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile;
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return await store.storedMaterial(resolution);
    },
  };
  const world = { clock: NOW };
  const anthropic = new AnthropicUsageProbe({ fetch: fetchOf(), credentials: store });
  const codex = new CodexUsageProbe({ fetch: fetchOf(), stored: counted, now: () => world.clock });
  const credentialReads = new CachedCredentialReads({
    reads: new MaterialCredentialReads({
      store: counted,
      probe: async (resolution, material) =>
        resolution.harness === 'claude' ? await anthropic.probeMaterial(material) : await codex.probeMaterial(material),
    }),
    stamp: credentialFileStamp,
    keychain: platform === 'darwin',
    keychainFreshMs: () => INTERVAL,
    now: () => world.clock,
    cache: new Map(),
  });
  const status = new CredentialStatusService({
    local: async (resolution, options) => await credentialReads.local(resolution, options),
    passiveUsage: async () => undefined,
    activeUsage: async resolution => await credentialReads.active(resolution),
    refresh: { refresh: async () => ({ outcome: 'error', reason: 'not in this test' }) },
    heads: new InMemoryCredentialStatusStore(),
    now: () => world.clock,
    usageIntervalMs: INTERVAL,
  });
  const emails = new CredentialEmailReader({
    codexFacts: async resolution => await credentialReads.local(resolution),
    stamp: credentialFileStamp,
    kept: new Map(),
  });
  const credentials = createFleetCredentialsSubsystem({
    catalog: new FleetCredentialCatalog({
      document: async () => model,
      paths: { fleetRoot, userHome: fleetRoot },
      inspect: async () => ({ reading: { state: 'missing' }, checked: [] }),
      ensureDirectory: async () => undefined,
    }),
    status,
    email: async source => await emails.email(source),
    machineName: () => 'studio',
    locate: () => undefined,
    run: async () => 0,
    baseEnvironment: () => ({}),
  });
  return Object.assign(world, { credentials, reads, spawns });
}

/** One unattended pass: the feed's settled list and the observation, at the same time. */
async function pass(subject: Machine): Promise<void> {
  await Promise.allSettled([subject.credentials.list({ settled: true }), subject.credentials.observeAll()]);
}

const total = (reads: Map<string, number>): number => [...reads.values()].reduce((sum, count) => sum + count, 0);

describe('the store reads one fleet pass costs', () => {
  it('should read each Linux store once a pass — the free read — and nothing for the list after', async () => {
    // Arrange
    const subject = await machine('linux');
    await pass(subject);
    subject.reads.clear();

    // Act — a pass one interval later, then a person opening the list.
    subject.clock = NOW + INTERVAL;
    await pass(subject);
    const perPass = total(subject.reads);
    const listed = await subject.credentials.list();

    // Assert — the first list of a fresh daemon fills what is kept; after that every store is read
    // once per pass, by its free read, and the list reads nothing.
    should(perPass).equal(3);
    should([...subject.reads.values()]).deepEqual([1, 1, 1]);
    should(total(subject.reads)).equal(3);
    should(listed.credentials.map(credential => credential.status.word)).deepEqual(['ready', 'ready', 'ready']);
    should(listed.credentials.find(credential => credential.id === 'cx')?.email).equal('team@example.com');
  });

  it('should spawn one `security` per idle Claude login per interval on a Mac, and none for the list', async () => {
    // Arrange
    const subject = await machine('darwin');
    await pass(subject);
    const firstPass = subject.spawns.count;

    // Act
    await subject.credentials.list();
    await subject.credentials.list();
    const listing = subject.spawns.count - firstPass;
    subject.clock = NOW + INTERVAL;
    await pass(subject);
    const secondPass = subject.spawns.count - firstPass - listing;

    // Assert — two Claude logins: two spawns a pass, where there were eight.
    should(listing).equal(0);
    should(secondPass).equal(2);
  });
});
