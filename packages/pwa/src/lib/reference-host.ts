/** Delivery callbacks for a reference-aware Markdown surface. */
import type { AttentionId } from '@ferretry/protocol';

import type { DaemonId } from './daemon-connection.ts';
import { daemonSessionPath } from './pages/routes.ts';
import type { CodeReference } from './references.ts';

export interface ReferenceOpenHost {
  readonly onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  readonly onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  readonly onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
}

/**
 * A fleet-level surface has no side pane of its own. Its honest fallback is
 * the referenced session on the daemon that owns it; the session host can then
 * open task, file, or attention detail. Requiring `daemonId` prevents an
 * identical session id on another pairing from becoming the destination.
 */
export const sessionReferenceHost = (
  daemonId: DaemonId,
  sessionId: string | null | undefined,
  onNavigate: (to: string) => void,
): ReferenceOpenHost => {
  if (!sessionId?.trim()) return {};
  const openSession = (): void => onNavigate(daemonSessionPath(daemonId, sessionId));
  return {
    onTaskOpen: openSession,
    onCodeReferenceOpen: openSession,
    onAttentionOpen: openSession,
  };
};
