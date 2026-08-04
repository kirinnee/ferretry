import { afterAll, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import {
  FileQuotaFailoverConfigStore,
  FileQuotaFailoverStateStore,
  QUOTA_FAILOVER_CONFIG_FILENAME,
  QUOTA_FAILOVER_DIRECTORY,
  QUOTA_FAILOVER_STATE_FILENAME,
  quotaFailoverRoot,
} from '../../../src/adapters/quota-failover/index.ts';
import {
  parseStoredQuotaFailoverConfig,
  parseStoredQuotaFailoverState,
  type QuotaFailoverState,
} from '../../../src/lib/quota-failover/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/** A throwaway state home with nothing in it yet — the first-boot situation. */
async function failoverHome(label: string): Promise<string> {
  return quotaFailoverRoot(path.join(await tempDirectory(label), 'state'));
}

const LEDGER: QuotaFailoverState = {
  sessions: {
    's-1': {
      moves: [
        {
          from: 'agent-a',
          to: 'agent-b',
          at: '2026-07-31T12:00:00.000Z',
          evidence: 'the usage feed measured agent-a at its limit (5h 100%)',
        },
      ],
      lastAttemptAt: '2026-07-31T12:00:00.000Z',
      lastOutcome: 'moved to agent-b',
    },
  },
  lastTick: { at: '2026-07-31T12:05:00.000Z', summary: '4 session(s) considered, 1 moved, 0 refused, 0 stranded' },
};

afterAll(cleanupTempDirectories);

describe('the durable quota-failover ledger', () => {
  it('should read as absent before any tick has written one', async () => {
    // Arrange
    const store = new FileQuotaFailoverStateStore(await failoverHome('quota-ledger-absent'));

    // Act / Assert — a state home that has never moved a session is a legitimate empty
    should(await store.read()).be.undefined();
  });

  it('should round-trip a ledger through the domain parser', async () => {
    // Arrange
    const store = new FileQuotaFailoverStateStore(await failoverHome('quota-ledger-roundtrip'));

    // Act
    await store.write(LEDGER);
    const parsed = parseStoredQuotaFailoverState(await store.read());

    // Assert
    should(parsed.kind).equal('ledger');
    should(parsed.kind === 'ledger' && parsed.state).deepEqual(LEDGER);
  });

  it('should create its directory owner-only on the first write', async () => {
    // Arrange — the document names which accounts a deployment pools together, which is topology
    const root = await failoverHome('quota-ledger-permissions');

    // Act
    await new FileQuotaFailoverStateStore(root).write(LEDGER);

    // Assert
    should((await stat(root)).mode & 0o777).equal(0o700);
    should((await stat(path.join(root, QUOTA_FAILOVER_STATE_FILENAME))).mode & 0o777).equal(0o600);
  });

  it('should leave no temporary file behind after an atomic write', async () => {
    // Arrange
    const root = await failoverHome('quota-ledger-atomic');
    const store = new FileQuotaFailoverStateStore(root);

    // Act — the ledger is rewritten twice per migration, so a torn write would lose a move record
    await store.write(LEDGER);
    await store.write({ sessions: {} });

    // Assert
    should(await readdir(root)).deepEqual([QUOTA_FAILOVER_STATE_FILENAME]);
  });

  it('should write the document as readable JSON with a trailing newline', async () => {
    // Arrange
    const root = await failoverHome('quota-ledger-shape');

    // Act
    await new FileQuotaFailoverStateStore(root).write(LEDGER);
    const raw = await readFile(path.join(root, QUOTA_FAILOVER_STATE_FILENAME), 'utf8');

    // Assert — an operator has to be able to read and hand-edit this
    should(raw.endsWith('\n')).be.true();
    should(JSON.parse(raw)).deepEqual(LEDGER);
  });

  it('should hand up the raw value rather than deciding what damage means', async () => {
    // Arrange — the ledger HALTS failover on damage while the configuration falls back; only the
    // domain knows that, so the adapter must not parse
    const root = await failoverHome('quota-ledger-damaged');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, QUOTA_FAILOVER_STATE_FILENAME), '{"sessions":{"s-1":{"moves":7}}}', 'utf8');

    // Act
    const parsed = parseStoredQuotaFailoverState(await new FileQuotaFailoverStateStore(root).read());

    // Assert
    should(parsed.kind).equal('damaged');
  });

  it('should read a file that is not JSON at all as absent rather than throwing', async () => {
    // Arrange
    const root = await failoverHome('quota-ledger-garbage');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, QUOTA_FAILOVER_STATE_FILENAME), 'not json {{{', 'utf8');

    // Act / Assert
    should(await new FileQuotaFailoverStateStore(root).read()).be.undefined();
  });

  it('should read an empty file as absent', async () => {
    // Arrange
    const root = await failoverHome('quota-ledger-empty');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, QUOTA_FAILOVER_STATE_FILENAME), '   \n', 'utf8');

    // Act / Assert
    should(await new FileQuotaFailoverStateStore(root).read()).be.undefined();
  });
});

describe('the quota-failover configuration document', () => {
  it('should read as absent before an operator has written one', async () => {
    // Arrange
    const store = new FileQuotaFailoverConfigStore(await failoverHome('quota-config-absent'));

    // Act
    const parsed = parseStoredQuotaFailoverConfig(await store.read());

    // Assert — the defaults are off twice over, so first boot moves nothing
    should(parsed.config.enabled).be.false();
    should(parsed.config.accounts).deepEqual([]);
    should(parsed.warnings).deepEqual([]);
  });

  it('should read a document an operator wrote by hand', async () => {
    // Arrange
    const root = await failoverHome('quota-config-written');
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, QUOTA_FAILOVER_CONFIG_FILENAME),
      JSON.stringify({ enabled: true, accounts: ['agent-a', 'agent-b'], headroomPercent: 60 }),
      'utf8',
    );

    // Act
    const parsed = parseStoredQuotaFailoverConfig(await new FileQuotaFailoverConfigStore(root).read());

    // Assert
    should(parsed.config.enabled).be.true();
    should(parsed.config.accounts).deepEqual(['agent-a', 'agent-b']);
    should(parsed.config.headroomPercent).equal(60);
  });

  it('should hand a damaged document up so the domain falls back and warns', async () => {
    // Arrange
    const root = await failoverHome('quota-config-damaged');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, QUOTA_FAILOVER_CONFIG_FILENAME), '{"enabled":"yes please"}', 'utf8');

    // Act
    const parsed = parseStoredQuotaFailoverConfig(await new FileQuotaFailoverConfigStore(root).read());

    // Assert
    should(parsed.config.enabled).be.false();
    should(parsed.warnings).have.length(1);
  });
});

describe('quotaFailoverRoot', () => {
  it('should name its own directory inside the state home, beside every other subsystem document', () => {
    // Arrange / Act / Assert
    should(quotaFailoverRoot('/state')).equal(path.join('/state', QUOTA_FAILOVER_DIRECTORY));
  });
});
