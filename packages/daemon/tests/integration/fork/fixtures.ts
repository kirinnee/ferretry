/**
 * Real state homes, real session documents, and one complete frozen plan for the fork adapters.
 *
 * These tests are in the integration tier because the adapters under test are the daemon's writers:
 * what they must be proved to do is put exact bytes into exact files under exact keys, and a fake
 * storage would prove only that they called the methods a fake was written to expect.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionTransferPlan } from '@ferretry/protocol';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';
import { SessionPlanner } from '../../../src/lib/core/session-planner.ts';
import { defaultStartWaitPolicy } from '../../../src/lib/core/display-model.ts';

export const AT = '2026-08-06T09:00:00.000Z';
export const SOURCE_ID = '20260806-source';
export const TARGET_ID = '20260806-target';

const directories = new Set<string>();

/** Removes every temporary home these fixtures opened. */
export async function cleanup(): Promise<void> {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
}

/** A real, locked state home with a real SQLite index behind it. */
export async function openStorage(
  label: string,
): Promise<{ storage: DaemonStorage; home: string; sessionDirectory: (id: string) => string }> {
  const home = await realTemporaryDirectory(`fy-fork-${label}-`);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(AT)),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  return {
    storage: opened.storage,
    home,
    sessionDirectory: (id: string) => join(opened.paths.sessions, id),
  };
}

/** A temporary directory, already canonical, so a resolved working directory equals what was asked for. */
export async function realTemporaryDirectory(prefix: string): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), prefix));
  directories.add(made);
  // `realpath` through `resolve` on a path mkdtemp already returned canonicalises the platform
  // aliases (`/tmp` against `/private/tmp`) the working-directory resolver would otherwise change.
  return resolve(made);
}

/** One published account, in the exact shape the fleet manifest declares. */
export function account(overrides: Partial<CoreAccount> = {}): CoreAccount {
  return {
    id: 'acct-target',
    agent: 'claude-auto-zelda',
    kind: 'claude',
    mode: 'auto',
    wrapper: '/fleet/bin/claude-auto-zelda',
    home: '/fleet/homes/zelda',
    displayName: 'Zelda',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
    ...overrides,
  };
}

/** The planner the composition root publishes, under a policy pinned for these tests. */
export function planner(): SessionPlanner {
  return new SessionPlanner({
    startWait: defaultStartWaitPolicy,
    contextWindowOverrides: { 'claude-opus-5': 1_000_000 },
    namePrefix: 'fy',
    remoteControlPrefix: 'fyrc',
  });
}

/**
 * A complete, schema-valid plan a preparation could have produced.
 *
 * The working directory is a REAL one, because the lifecycle canonicalises it and refuses a
 * directory an agent could not have started in.
 */
export function plan(cwd: string, overrides: Partial<SessionTransferPlan> = {}): SessionTransferPlan {
  return {
    v: 1,
    planId: 'plan-fork-1',
    preparedAt: AT,
    source: {
      sessionId: SOURCE_ID,
      incarnation: `${SOURCE_ID}-1`,
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude-auto-source',
      model: 'claude-opus-5',
      teammate: 'alistair',
      name: 'Port The Transfer Seam',
      label: 'f117',
      transcriptProvenance: {
        v: 1,
        home: '/fleet/homes/source',
        harnessSessionId: 'harness-source',
        identity: 'minted',
        file: '/fleet/homes/source/projects/source.jsonl',
        resolvedAt: AT,
      },
      cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
    },
    target: {
      accountId: 'acct-target',
      agent: 'claude-auto-zelda',
      harness: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
      contextWindow: 1_000_000,
    },
    durable: {
      cwd,
      mode: 'auto',
      parentSessionId: null,
      boardAccess: 'none',
      label: 'f117',
      harnessFlags: ['--dangerously-skip-permissions'],
      remoteControl: true,
      intervalSeconds: 30,
      timeoutSeconds: 600,
      nudgeAfterSeconds: 120,
      killAfterSeconds: 900,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    },
    facets: {
      conversation: {
        messages: [
          { point: { v: 1, byteOffset: 0, blockIndex: 0 }, role: 'user', text: 'carry this', timestamp: AT },
          { point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'assistant', text: 'and this', timestamp: AT },
        ],
      },
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd, head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: true, warden: '20260806-warden' },
    },
    notCarried: [
      {
        facet: 'workspace',
        subject: cwd,
        reason: 'not_implemented',
        detail: 'conversation time was rewound but filesystem state was not',
      },
    ],
    ...overrides,
  };
}
