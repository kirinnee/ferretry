import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  CARRIERS_JOURNAL_NAME,
  DaemonConfigDocumentError,
  FileDaemonConfig,
  RetiredDaemonKeysError,
} from '../../../src/adapters/runtime/daemon-config.ts';
import { ExplicitDaemonConfig } from '../../../src/adapters/runtime/explicit-config.ts';
import { analyticsPricingFingerprint } from '../../../src/lib/analytics/pricing-catalog.ts';
import type {
  AnalyticsPricingConfigurationRead,
  AnalyticsPricingConfigurationWrite,
  AnalyticsPricingConfigurationWriteResult,
} from '../../../src/lib/analytics/pricing-service.ts';
import {
  createFoundationPaths,
  type DaemonConfig,
  type DaemonTunnelCarrierEntry,
  type FileSystemPort,
  type FoundationPaths,
  resolveStateHome,
} from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/** What both configuration adapters offer a caller, so one set of cases holds them to the same bar. */
interface ConfigAdapter {
  load: () => Promise<DaemonConfig>;
  peek: () => Promise<{ readonly document: Record<string, unknown> | undefined; readonly config: DaemonConfig }>;
  record: (port: number) => Promise<void>;
  writeTunnelEntry: (entry: DaemonTunnelCarrierEntry) => Promise<void>;
  readPricing: () => Promise<AnalyticsPricingConfigurationRead>;
  writePricing: (input: AnalyticsPricingConfigurationWrite) => Promise<AnalyticsPricingConfigurationWriteResult>;
}

/** An adapter over one document, and the means to see what is on disk afterwards. */
interface Subject {
  readonly store: ConfigAdapter;
  readonly text: () => Promise<string | undefined>;
}

const STATE_HOME_FILE = '/state/config/daemon.json';
const TUNNEL: DaemonTunnelCarrierEntry = { kind: 'tunnel', source: 'discovery', enabled: false };
const NO_PRICING_CHANGE: AnalyticsPricingConfigurationWrite = {
  catalog: [],
  expectedCatalogFingerprint: analyticsPricingFingerprint([]),
  touchedPricingKeys: [],
};

/** The state-home adapter over an in-memory document: what reaches `writeTextAtomic` is what we read back. */
function stateHome(initial: string): Subject {
  let text: string | undefined = initial;
  const files = {
    readText: async () => text,
    writeTextAtomic: async (_path: string, next: string) => {
      text = next;
    },
  } as Pick<FileSystemPort, 'readText' | 'writeTextAtomic'> as FileSystemPort;
  const paths = { daemonConfig: STATE_HOME_FILE, home: '/state' } as FoundationPaths;
  return { store: new FileDaemonConfig(paths, files), text: async () => text };
}

/** The `--config` adapter over a real file in a temporary directory. */
async function explicit(initial: string): Promise<Subject & { readonly path: string }> {
  const directory = await tempDirectory('fyd-retired-keys');
  const path = join(directory, 'daemon.json');
  await writeFile(path, initial);
  return { store: new ExplicitDaemonConfig(path), text: async () => await readFile(path, 'utf8'), path };
}

const ADAPTERS: ReadonlyArray<{
  readonly name: string;
  readonly subject: (document: string) => Promise<Subject>;
  readonly file: (subject: Subject) => string;
}> = [
  {
    name: 'FileDaemonConfig (state home)',
    subject: async document => stateHome(document),
    file: () => STATE_HOME_FILE,
  },
  {
    name: 'ExplicitDaemonConfig (--config)',
    subject: async document => await explicit(document),
    file: subject => (subject as Subject & { readonly path: string }).path,
  },
];

const RETIRED: ReadonlyArray<{ readonly key: string; readonly document: unknown; readonly remedy: string }> = [
  {
    key: 'attention',
    document: { attention: { replySettleSeconds: 4242 } },
    remedy: 'rename `attention` to `agenda` in config/daemon.json',
  },
  {
    key: 'accountModel',
    document: { accountModel: { enabled: 4242 } },
    remedy: 'remove `accountModel` from config/daemon.json; it is no longer read',
  },
  {
    key: 'fleet',
    document: { fleet: { prepareDefaults: 4242 } },
    remedy: 'remove `fleet` from config/daemon.json; it is no longer read',
  },
  {
    key: 'sessionWorkers.enabled',
    document: { sessionWorkers: { enabled: false, max: 4242 } },
    remedy: 'remove `enabled` from `sessionWorkers` in config/daemon.json; it is no longer read',
  },
];

/** Asserts a refusal that names the key and the remedy and never prints a value from the document. */
function shouldRefuse(raised: unknown, key: string, remedy: string): void {
  should(raised).be.instanceOf(DaemonConfigDocumentError);
  const message = (raised as Error).message;
  should(message).containEql(`"${key}"`);
  should(message).containEql(remedy);
  should(message).not.containEql('Unrecognized');
  should(message).not.containEql('4242');
}

for (const adapter of ADAPTERS) {
  describe(`${adapter.name}: a daemon.json that still holds a retired key`, () => {
    afterEach(async () => await cleanupTempDirectories());

    for (const { key, document, remedy } of RETIRED) {
      describe(key, () => {
        const text = JSON.stringify(document);

        it('should refuse to load, naming the file, the key and the remedy', async () => {
          // Arrange
          const subject = await adapter.subject(text);

          // Act
          const raised = await subject.store.load().catch((error: unknown) => error);

          // Assert
          shouldRefuse(raised, key, remedy);
          should((raised as Error).message).containEql(adapter.file(subject));
        });

        it('should refuse to peek, and leave the document alone', async () => {
          // Arrange
          const subject = await adapter.subject(text);

          // Act
          const raised = await subject.store.peek().catch((error: unknown) => error);

          // Assert
          shouldRefuse(raised, key, remedy);
          should(await subject.text()).equal(text);
        });

        it('should refuse to record a port, and write nothing', async () => {
          // Arrange
          const subject = await adapter.subject(text);

          // Act
          const raised = await subject.store.record(9_800).catch((error: unknown) => error);

          // Assert
          shouldRefuse(raised, key, remedy);
          should(await subject.text()).equal(text);
        });

        it('should refuse to write the tunnel entry, and write nothing', async () => {
          // Arrange
          const subject = await adapter.subject(text);

          // Act
          const raised = await subject.store.writeTunnelEntry(TUNNEL).catch((error: unknown) => error);

          // Assert
          shouldRefuse(raised, key, remedy);
          should(await subject.text()).equal(text);
        });

        it('should answer a pricing read as unavailable with the retired-key sentence', async () => {
          // Arrange
          const subject = await adapter.subject(text);

          // Act
          const actual = await subject.store.readPricing();

          // Assert
          if (actual.kind !== 'unavailable') throw new Error(`expected unavailable, got ${actual.kind}`);
          should(actual.message).containEql(`"${key}"`);
          should(actual.message).containEql(remedy);
          should(actual.message).not.containEql('4242');
        });

        it('should answer a pricing write as unavailable with the retired-key sentence, and write nothing', async () => {
          // Arrange
          const subject = await adapter.subject(text);

          // Act
          const actual = await subject.store.writePricing(NO_PRICING_CHANGE);

          // Assert
          if (actual.kind !== 'unavailable') throw new Error(`expected unavailable, got ${actual.kind}`);
          should(actual.message).containEql(`"${key}"`);
          should(actual.message).containEql(remedy);
          should(actual.message).not.containEql('4242');
          should(await subject.text()).equal(text);
        });
      });
    }

    it('should name every retired key when several are held', async () => {
      // Arrange
      const subject = await adapter.subject(JSON.stringify({ attention: {}, accountModel: {}, fleet: {} }));

      // Act
      const raised = (await subject.store.load().catch((error: unknown) => error)) as Error;

      // Assert
      for (const key of ['attention', 'accountModel', 'fleet']) should(raised.message).containEql(`"${key}"`);
    });

    it('should keep a malformed pricing document sanitized rather than echoing the schema dump', async () => {
      // Arrange — not a retired key: a live key with the wrong shape.
      const subject = await adapter.subject(JSON.stringify({ analyticsPricing: 'secret-looking-value' }));

      // Act
      const actual = await subject.store.readPricing();

      // Assert
      if (actual.kind !== 'unavailable') throw new Error(`expected unavailable, got ${actual.kind}`);
      should(actual.message).equal('the daemon configuration document cannot be read as pricing');
    });

    it('should still load a document that only has the live agenda block', async () => {
      // Arrange
      const subject = await adapter.subject(JSON.stringify({ agenda: { replySettleSeconds: 30 } }));

      // Act
      const config = await subject.store.load();

      // Assert
      should(config.agenda.replySettleSeconds).equal(30);
    });
  });
}

/** The state-home adapter over a REAL state home, so a conversion that wrote anything leaves a file behind. */
async function realStateHome(daemonJson: string): Promise<{
  readonly store: FileDaemonConfig;
  readonly paths: FoundationPaths;
}> {
  const home = await tempDirectory('fyd-retired-keys-conversion');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
  await mkdir(dirname(paths.daemonConfig), { recursive: true });
  await writeFile(paths.daemonConfig, daemonJson, { mode: 0o600 });
  return { store: new FileDaemonConfig(paths, new StateFileSystem(paths)), paths };
}

describe('FileDaemonConfig: the carriers conversion on a daemon.json that still holds a retired key', () => {
  afterEach(async () => await cleanupTempDirectories());

  const WITH_LEGACY_PORT: ReadonlyArray<{ readonly key: string; readonly document: unknown }> = [
    { key: 'attention', document: { port: 7431, attention: { replySettleSeconds: 4242 } } },
    { key: 'accountModel', document: { port: 7431, accountModel: { enabled: 4242 } } },
    { key: 'fleet', document: { port: 7431, fleet: { prepareDefaults: 4242 } } },
    { key: 'sessionWorkers.enabled', document: { port: 0, sessionWorkers: { enabled: false } } },
  ];

  for (const { key, document } of WITH_LEGACY_PORT) {
    it(`should refuse ${key} with a legacy port by name and leave the state home byte-identical`, async () => {
      // Arrange
      const text = JSON.stringify(document);
      const { store, paths } = await realStateHome(text);
      // `readdir` promises no order, so the listings are compared sorted.
      const before = (await readdir(paths.home, { recursive: true })).toSorted();

      // Act
      const raised = await store.convertLegacyCarrierKeys('2026-11-06T10:20:30.456Z').catch((error: unknown) => error);

      // Assert
      should(raised).be.instanceOf(RetiredDaemonKeysError);
      should((raised as Error).message).containEql(`"${key}"`);
      should((raised as Error).message).not.containEql('Unrecognized');
      should((raised as Error).message).not.containEql('4242');
      should(await readFile(paths.daemonConfig, 'utf8')).equal(text);
      should((await readdir(paths.home, { recursive: true })).toSorted()).deepEqual(before);
      should(before.some(entry => entry.includes(CARRIERS_JOURNAL_NAME) || entry.includes('pre-carriers'))).be.false();
    });
  }

  it('should still convert a legacy port in a document with no retired key', async () => {
    // Arrange
    const { store, paths } = await realStateHome(JSON.stringify({ host: '127.0.0.1', port: 7431 }));

    // Act
    const outcome = await store.convertLegacyCarrierKeys('2026-11-06T10:20:30.456Z');

    // Assert
    should(outcome.kind).equal('converted');
    should(JSON.parse(await readFile(paths.daemonConfig, 'utf8'))).deepEqual({
      carriers: [{ kind: 'bind', host: '127.0.0.1', port: 7431 }],
    });
  });
});
