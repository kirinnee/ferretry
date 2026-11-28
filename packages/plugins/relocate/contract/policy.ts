import { auditKind } from '@ferretry/core-gate/contract';

/**
 * Relocate's audit kinds (§7.1). A move is a fleet write that reads one working tree, so each end of it is kept: the
 * snapshot that was sealed (`relocate.exported`, the ferret's id and the target daemon's id, never a path or a byte) and
 * the moment the source became a stub (`relocate.moved`). The target keeps its own end: `relocate.imported`, the ferret's new id and the source daemon's id.
 */
export const RELOCATE_AUDIT = {
  exported: auditKind('relocate.exported'),
  moved: auditKind('relocate.moved'),
  imported: auditKind('relocate.imported'),
} as const;
