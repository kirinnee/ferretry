import type { SessionId } from './session-id.ts';
import type { IndexedSession, JournalFingerprint } from './storage-types.ts';

export const CURRENT_INDEX_SCHEMA_VERSION = 1 as const;

export type IndexSchemaDecision = 'create' | 'use' | 'drop-and-rebuild';

export function decideIndexSchema(foundVersion: number, hasTables: boolean): IndexSchemaDecision {
  if (!hasTables) return 'create';
  return foundVersion === CURRENT_INDEX_SCHEMA_VERSION ? 'use' : 'drop-and-rebuild';
}

export interface DiskSessionObservation {
  readonly id: SessionId;
  readonly journal: JournalFingerprint | null;
  readonly lastIndexedEventMatches: boolean;
}

export type ReconciliationAction =
  | { readonly kind: 'rescan'; readonly id: SessionId }
  | {
      readonly kind: 'scan-tail';
      readonly id: SessionId;
      readonly fromOffset: number;
      readonly fromSequence: number;
      readonly fromLine: number;
    }
  | { readonly kind: 'refresh-metadata'; readonly id: SessionId }
  | { readonly kind: 'forget'; readonly id: SessionId };

function sameFile(left: JournalFingerprint, right: JournalFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameFingerprint(left: JournalFingerprint, right: JournalFingerprint): boolean {
  return sameFile(left, right) && left.size === right.size && left.modifiedAtMs === right.modifiedAtMs;
}

function decideSync(disk: DiskSessionObservation, indexed: IndexedSession): ReconciliationAction {
  if (disk.journal === null || indexed.journal === null) {
    return disk.journal === indexed.journal
      ? { kind: 'refresh-metadata', id: disk.id }
      : { kind: 'rescan', id: disk.id };
  }
  if (sameFingerprint(disk.journal, indexed.journal) && disk.lastIndexedEventMatches) {
    return { kind: 'refresh-metadata', id: disk.id };
  }
  if (
    sameFile(disk.journal, indexed.journal) &&
    disk.journal.size > indexed.journal.size &&
    disk.lastIndexedEventMatches
  ) {
    return {
      kind: 'scan-tail',
      id: disk.id,
      fromOffset: indexed.journal.size,
      fromSequence: indexed.lastSequence,
      fromLine: indexed.journalLine,
    };
  }
  return { kind: 'rescan', id: disk.id };
}

export function planReconciliation(
  diskSessions: readonly DiskSessionObservation[],
  indexedSessions: readonly IndexedSession[],
): readonly ReconciliationAction[] {
  const disk = new Map(diskSessions.map(session => [session.id, session]));
  const indexed = new Map(indexedSessions.map(session => [session.id, session]));
  const ids = new Set([...disk.keys(), ...indexed.keys()]);
  return [...ids].sort().map(id => {
    const onDisk = disk.get(id);
    const inIndex = indexed.get(id);
    if (onDisk && inIndex) return decideSync(onDisk, inIndex);
    if (onDisk) return { kind: 'rescan', id } as const;
    return { kind: 'forget', id } as const;
  });
}
