/**
 * In-memory state, session documents, and one complete frozen plan for the fork adapters.
 *
 * These tests are in the integration tier because the adapters under test are the daemon's writers: what they must be
 * proved to do is put exact documents under exact keys, and a fake storage would prove only that they called the
 * methods a fake was written to expect. The state is the kernel test host's `MemoryStateFolder` — a real
 * `StatePort` with the declared files' format and schema checks — so what is written is what the kernel would hold.
 * The one real directory is the target's WORKING directory, which the lifecycle canonicalises and refuses unless an
 * agent could really start in it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { diskSessionsRoots, type MemoryStateFolder } from '@ferretry/kernel/testing';
import { TransferPlanFiles } from '../../../../contract/transfer-state.ts';
import type { RootHandle } from '@ferretry/kernel/contract';
import type { SessionId } from '../../../../daemon/lib/session-id.ts';
import type { SessionTransferPlan } from '../../../../contract/transfer.ts';
import { ForkFiles } from '../../../../contract/index.ts';
import type { DaemonStorage } from '../../../../daemon/adapters/storage/session-storage.ts';
import type { ForkHarnessFacts } from '../../../../daemon/lib/forks/ports.ts';
import type { RuntimeControlRequest } from '../../../../daemon/lib/protocol/session.ts';
import type { SessionEffectKey, SessionEffectLedger } from '../../../../daemon/lib/session/effects/index.ts';
import type { CoreAccount, SessionPlanner as SessionPlannerPort } from '../../../../daemon/lib/session/peers/core.ts';
import type { HarnessKind } from '../../../../daemon/lib/session/peers/fleet.ts';
import type {
  AttachmentFile,
  TransferAttachmentStore,
  TransferStoredManifest,
} from '../../../../daemon/lib/transfer/ports.ts';
import { defaultStartWaitPolicy, SessionPlanner } from '../../../unit/daemon/session/launch/planner-fixture.ts';
import { memoryStorage, SESSION_STORE_FILES } from '../../../support/daemon/storage.ts';

export const AT = '2026-08-06T09:00:00.000Z';
export const SOURCE_ID = '20260806-source';
export const TARGET_ID = '20260806-target';

/** Every declared file a fork touches on the state port: the session store's, the receipts and the target's plan. */
const FORK_STATE_FILES = [...SESSION_STORE_FILES, ForkFiles, TransferPlanFiles] as const;

const directories = new Set<string>();

/** Removes every temporary working directory these fixtures made. */
export async function cleanup(): Promise<void> {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
}

/**
 * A session store over a memory state folder, the state port a fork's own files are read and written through, and
 * every ferret's REAL private folder on the kernel's `sessions` root, where a target's brief is its `turns/turn-001.md`.
 */
export async function openStorage(_label: string): Promise<{
  storage: DaemonStorage;
  folder: MemoryStateFolder;
  state: ReturnType<MemoryStateFolder['port']>;
  sessionDirectory: (id: string) => string;
  briefs: (id: SessionId) => RootHandle;
  /** The brief on disk now, or `undefined` when there is none (read directly, beside the store). */
  briefText: (id: string) => string | undefined;
  /** Puts bytes at the brief's name directly, as a crash or a hand edit would leave them. */
  plantBrief: (id: string, text: string) => void;
}> {
  const opened = await memoryStorage({ clock: { now: () => AT } });
  const parent = await mkdtemp(join(tmpdir(), 'fy-fork-sessions-'));
  directories.add(parent);
  const sessions = await diskSessionsRoots(parent);
  const briefFile = (id: string): string => join(sessions.folderOf(id), 'turns', 'turn-001.md');
  return {
    storage: opened.storage,
    folder: opened.folder,
    state: opened.folder.port(FORK_STATE_FILES),
    // The target's own private folder: the string a rollout is later correlated by, and where its brief is.
    sessionDirectory: (id: string) => sessions.folderOf(id),
    briefs: id => sessions.root(id),
    briefText: id => {
      try {
        return readFileSync(briefFile(id), 'utf8');
      } catch {
        return undefined;
      }
    },
    plantBrief: (id, text) => {
      mkdirSync(dirname(briefFile(id)), { recursive: true, mode: 0o700 });
      writeFileSync(briefFile(id), text, { mode: 0o600 });
    },
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

/**
 * The attachment owner's store, in memory: files by session, attachment and kind.
 *
 * It is the owner's PORT (`TransferAttachmentStore`), so a fork copies through the one writer a later download reads —
 * there is no second layout for a copier to disagree with. `parseManifest` accepts exactly a manifest of the durable keys.
 */
export class MemoryAttachmentStore implements TransferAttachmentStore {
  readonly files = new Map<string, Uint8Array>();

  private key(sessionId: string, attachmentId: string, file: AttachmentFile): string {
    return `${sessionId}/${attachmentId}/${file}`;
  }

  async read(sessionId: string, attachmentId: string, file: AttachmentFile): Promise<Uint8Array | undefined> {
    const held = this.files.get(this.key(sessionId, attachmentId, file));
    return held === undefined ? undefined : new Uint8Array(held);
  }

  async write(sessionId: string, attachmentId: string, file: AttachmentFile, bytes: Uint8Array): Promise<void> {
    this.files.set(this.key(sessionId, attachmentId, file), new Uint8Array(bytes));
  }

  parseManifest(document: unknown, attachmentId: string): TransferStoredManifest {
    const manifest = document as Partial<TransferStoredManifest> | null;
    if (manifest === null || typeof manifest !== 'object' || manifest.id !== attachmentId)
      throw new Error(`manifest does not describe attachment ${attachmentId}`);
    return manifest as TransferStoredManifest;
  }
}

/** The harness plugins' facts, as the quirk table and the launch argv declare them. */
export const harnessFacts: ForkHarnessFacts = {
  quirks: (harness: HarnessKind) =>
    harness === 'claude'
      ? { effortIsRuntimeCommand: true, mintsOwnSessionIds: false }
      : { effortIsRuntimeCommand: false, mintsOwnSessionIds: true },
  startupModelArguments: (model: string) => ['--model', model],
  claudeTranscriptFile: (home: string, cwd: string, harnessSessionId: string) =>
    join(home, 'projects', cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-'), `${harnessSessionId}.jsonl`),
};

/** One published account, in the exact shape the fleet manifest declares. */
export function account(overrides: Partial<CoreAccount> = {}): CoreAccount {
  return {
    secretEnv: {},
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

/** The planner the host publishes, under a policy pinned for these tests. */
export function planner(): SessionPlannerPort {
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

/** A fixture-local durable-effect stand-in: every lifecycle rebuilt by one harness shares it. */
export function memoryEffectLedger(): SessionEffectLedger {
  const held = new Map<string, { readonly fingerprint: string; readonly settled: boolean }>();
  const identity = (key: SessionEffectKey): string => JSON.stringify([key.sessionId, key.effectId]);

  return {
    inspect: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect === undefined) return 'unclaimed';
      if (effect.fingerprint !== fingerprint) return 'conflict';
      return effect.settled ? 'settled' : 'unsettled';
    },
    begin: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect !== undefined) {
        if (effect.fingerprint !== fingerprint) return 'conflict';
        return effect.settled ? 'settled' : 'unsettled';
      }
      held.set(identity(key), { fingerprint, settled: false });
      return 'perform';
    },
    settle: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect === undefined || effect.fingerprint !== fingerprint)
        throw new Error(`cannot settle unclaimed or conflicting effect ${key.effectId}`);
      held.set(identity(key), { fingerprint, settled: true });
    },
  };
}

/** The runtime subsystem's opaque comparison, repeated only by this stateful port stand-in. */
export function runtimeEffectFingerprint(request: RuntimeControlRequest): string {
  return JSON.stringify([
    request.action,
    request.action === 'model' || request.action === 'effort' ? (request.effort ?? null) : null,
    request.action === 'model' ? (request.model ?? null) : null,
  ]);
}
