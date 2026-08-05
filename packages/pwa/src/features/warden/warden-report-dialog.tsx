/** The complete evidence behind one concise Warden verdict. */

import { Gavel, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.tsx';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { WardenVerdictView } from './warden-verdicts.tsx';

export interface WardenReportDialogRequest {
  readonly connection: DaemonConnection;
  readonly verdict: WardenVerdictView;
}

export type WardenReportReader = (connection: DaemonConnection, reportPath: string) => Promise<string>;

export function WardenReportDialog({
  request,
  read,
  onClose,
}: {
  readonly request: WardenReportDialogRequest | null;
  readonly read: WardenReportReader;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(request !== null, dialogRef, onClose);
  const [body, setBody] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (request === null) return;
    let cancelled = false;
    setBody(null);
    setUnavailable(false);
    void read(request.connection, request.verdict.reportPath)
      .then(next => {
        if (!cancelled) setBody(next);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [read, request]);

  if (request === null) return null;
  const title = request.verdict.reportPath.split('/').at(-1) ?? 'Warden report';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button type="button" aria-label="Close Warden report" className="absolute inset-0" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="kt-panel relative flex max-h-[min(86dvh,760px)] w-full max-w-3xl flex-col overflow-hidden p-0 shadow-popover focus:outline-none"
      >
        <header className="flex min-w-0 items-center gap-sm border-b border-border-soft px-cell-x py-2">
          <Gavel size={15} className="shrink-0 text-faint" aria-hidden="true" />
          <h2 id={titleId} className="mono min-w-0 flex-1 truncate text-ui font-medium text-fg">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close Warden report"
            className="kt-btn h-9 w-9 shrink-0 p-0"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 overflow-auto px-cell-x py-3 text-ui leading-base">
          {body === null && !unavailable && <p className="m-0 text-muted">Loading report evidence…</p>}
          {unavailable && (
            <section className="rounded-control border border-warn-border bg-warn-bg p-3 text-warn" role="alert">
              <h3 className="m-0 text-ui font-semibold">Report evidence unavailable</h3>
              <p className="mb-0 mt-1 text-cell">
                Ferretry could not read this report. It is not being treated as an empty or healthy verdict.
              </p>
            </section>
          )}
          {body !== null && <Markdown text={body} />}
        </div>
      </div>
    </div>
  );
}
