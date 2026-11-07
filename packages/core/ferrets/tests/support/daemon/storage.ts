/**
 * A `DaemonStorage` over the kernel test host's state (`MemoryStateFolder`): the declared session files, the
 * contract's journal, index and archive registry, and nothing on disk. The folder outlives the storage, so a test can
 * open a second storage on the same files (a restart), plant a damaged file, or read what was written.
 */
import type { Log, LogFields } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import {
  ArchiveFile,
  FerretHistoryFiles,
  FerretIndexFile,
  FerretConfigFile,
  FerretStateFile,
} from '../../../contract/index.ts';
import type { SessionProtocolEnvelope } from '../../../daemon/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import type { ClockPort, SessionIndex, YieldingSerialExecutor } from '../../../daemon/lib/ports.ts';

/** Every file the session store reads or writes. */
export const SESSION_STORE_FILES = [
  FerretConfigFile,
  FerretStateFile,
  FerretHistoryFiles,
  FerretIndexFile,
  ArchiveFile,
] as const;

export const T0 = '2026-11-06T12:00:00.000Z';

/** A log that keeps what it was told. */
export class RecordingLog implements Log {
  readonly lines: { readonly level: string; readonly message: string; readonly fields?: LogFields }[] = [];
  debug(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, fields });
  }
  child(): Log {
    return this;
  }
}

export interface MemoryStorageOptions {
  readonly folder?: MemoryStateFolder;
  readonly clock?: ClockPort;
  readonly log?: Log;
  readonly index?: (folder: MemoryStateFolder) => SessionIndex;
  readonly serial?: YieldingSerialExecutor;
}

export interface MemoryStorage {
  readonly storage: DaemonStorage;
  readonly folder: MemoryStateFolder;
  readonly log: RecordingLog | Log;
}

/** A storage, its archive loaded, over a memory state folder (a fresh one unless given). */
export async function memoryStorage(options: MemoryStorageOptions = {}): Promise<MemoryStorage> {
  const folder = options.folder ?? new MemoryStateFolder();
  const log = options.log ?? new RecordingLog();
  const state = folder.port(SESSION_STORE_FILES);
  const storage = new DaemonStorage(
    state,
    options.clock ?? { now: () => T0 },
    log,
    options.index?.(folder),
    options.serial,
  );
  await storage.loadArchive();
  return { storage, folder, log };
}

/** Everything `SessionConfigSchema` demands, so a written config passes its declared schema. */
export function sessionConfig(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    incarnation: `${id}-1`,
    runtimeGeneration: 1,
    name: 'zelda',
    agent: 'claude-auto-atomi',
    harness: 'claude',
    modelHint: '',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work/repo',
    createdAt: T0,
    updatedAt: T0,
    turn: 0,
    intervalSeconds: 30,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 120,
    killAfterSeconds: 900,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'full',
    maxSnapshots: 5,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    ...fields,
  };
}

/** Everything `SessionStateSchema` demands. */
export function sessionState(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, status: 'running', turn: 0, ...fields };
}

/**
 * The protocol half of a session configuration that a start decides and the lifecycle does not
 * (`SessionProtocolEnvelope`): handed to `StorageSessionLifecycleRepository` so the configuration it writes meets the
 * declared `SessionConfigSchema`, as every start's does.
 */
export function sessionEnvelope(overrides: Record<string, unknown> = {}): SessionProtocolEnvelope {
  return {
    incarnation: 'envelope-1',
    runtimeGeneration: 1,
    agent: 'claude-auto-loge',
    harness: 'claude',
    modelHint: '',
    remoteControl: false,
    harnessFlags: [],
    turn: 0,
    intervalSeconds: 30,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 120,
    killAfterSeconds: 900,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'full',
    maxSnapshots: 5,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    ...overrides,
  } as SessionProtocolEnvelope;
}
