/**
 * Info › Runtime's Settings row: whether this ferret's CLI runs on the settings a Restart would give it.
 *
 * A running CLI keeps what it read at launch. The login's permission mode, its profile, the fixed
 * layer and the arguments Ferretry launches with all reach it only when it restarts, so after a change
 * the row says "Running with older settings — Restart to apply" and offers the Restart right there. A
 * Restart relaunches on the same login, resumes the conversation, and keeps the model and effort the
 * ferret is on.
 */

import type { SessionRelaunchDrift, SessionRelaunchSettings } from '@ferretry/protocol';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { InfoChip, InfoRow } from './info-parts.tsx';

/** The read behind the row: unread, read, or failed with a reason. */
export type InfoRelaunchRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly settings: SessionRelaunchSettings }
  | { readonly kind: 'failed'; readonly reason: string };

export const INFO_RELAUNCH_HINT =
  'A running CLI keeps the settings it started with. Login settings (permission mode, profile, MCP servers, skills, instructions) apply on its next restart; Restart keeps the conversation, the model and the effort.';

/** Each reason, in words. */
export const RELAUNCH_REASON: Readonly<Record<SessionRelaunchDrift, string>> = {
  arguments: 'Ferretry now starts this CLI with arguments it is missing.',
  settings: 'This login’s settings changed after it started.',
};

type RestartState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly reason: string };

export function InfoRelaunchRow({
  read,
  onRestart,
}: {
  readonly read: InfoRelaunchRead;
  /** The same Restart as Actions › Restart CLI. Absent when this viewer may not restart it. */
  readonly onRestart?: () => Promise<void>;
}) {
  const [restart, setRestart] = useState<RestartState>({ kind: 'idle' });
  const run = (): void => {
    if (onRestart === undefined) return;
    setRestart({ kind: 'busy' });
    onRestart().then(
      () => setRestart({ kind: 'done' }),
      (error: unknown) =>
        setRestart({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) }),
    );
  };
  return (
    <InfoRow hint={INFO_RELAUNCH_HINT} label="Settings">
      {read.kind === 'loading' ? (
        <span className="fy-info-muted">Checking…</span>
      ) : read.kind === 'failed' ? (
        <span className="fy-info-muted">Couldn’t check: {read.reason}</span>
      ) : restart.kind === 'done' ? (
        <span className="fy-info-line" data-info-settings="restarted">
          <InfoChip tone="ok">Restarted</InfoChip>
          <span className="fy-info-muted">on current settings</span>
        </span>
      ) : read.settings.current ? (
        <span data-info-settings="current">
          <InfoChip tone="ok">Current</InfoChip>
        </span>
      ) : (
        <>
          <span className="fy-info-line" data-info-settings="stale">
            <InfoChip tone="warn">
              <TriangleAlert aria-hidden="true" size={11} />
              Older settings
            </InfoChip>
            <span>Running with older settings — Restart to apply</span>
          </span>
          {read.settings.reasons.map(reason => (
            <span className="fy-info-line fy-info-muted" key={reason}>
              {RELAUNCH_REASON[reason]}
            </span>
          ))}
          {onRestart === undefined ? null : (
            <span className="fy-info-line">
              <button
                className="fy-info-inline-action"
                data-info-restart=""
                disabled={restart.kind === 'busy'}
                onClick={run}
                type="button"
              >
                {restart.kind === 'busy' ? 'Restarting…' : 'Restart'}
              </button>
              {restart.kind === 'failed' ? (
                <span className="fy-info-muted" role="alert">
                  Couldn’t restart: {restart.reason}
                </span>
              ) : null}
            </span>
          )}
        </>
      )}
    </InfoRow>
  );
}
