import type { StartSessionRequest } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { DaemonConnection } from '../lib/daemon-connection.ts';
import {
  canSubmitNewSession,
  emptyNewSessionDraft,
  submitNewSession,
  type NewSessionDraft,
} from '../lib/pages/new-session.ts';
import { daemonSessionPath, daemonSessionsPath } from '../lib/pages/routes.ts';
import { cn } from '../lib/class-names.ts';
import { Button, Card, PanelBody, Textarea } from '../shell/primitives.tsx';

export interface NewSessionPageProps {
  /** The concrete daemon selected by pairing and matched by the current route. */
  readonly connection: DaemonConnection;
  /**
   * The host's typed-client adapter. Passing the connection through this seam is
   * deliberate: a browser paired to two daemons must never create a session on
   * whichever client happened to be initialized most recently.
   */
  readonly startSession: (
    connection: DaemonConnection,
    request: StartSessionRequest,
  ) => Promise<{ readonly config: { readonly id: string } }>;
  /** Receives canonical daemon-scoped paths for both cancel and successful creation. */
  readonly onNavigate: (path: string) => void;
}

type TextDraftField = Exclude<keyof NewSessionDraft, 'mode'>;

const fieldId = (field: TextDraftField): string => `fy-new-session-${field}`;

/**
 * The PWA new-session surface. The original app enriches the free-text account
 * and project fields from daemon-specific catalog routes; those routes are not
 * part of Ferretry's public protocol, so this is intentionally its defensive
 * fallback presentation rather than a fabricated, unpaired catalogue.
 */
export function NewSessionPage({ connection, startSession, onNavigate }: NewSessionPageProps) {
  const [draft, setDraft] = useState<NewSessionDraft>(emptyNewSessionDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (field: TextDraftField, value: string): void => setDraft(current => ({ ...current, [field]: value }));
  const canSubmit = canSubmitNewSession(draft, connection, submitting);
  const sessionsPath = daemonSessionsPath(connection.daemonId);

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const scope = await submitNewSession(draft, {
        connection,
        start: request => startSession(connection, request),
      });
      onNavigate(daemonSessionPath(scope.daemonId, scope.sessionId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  };

  return (
    <main
      aria-labelledby="new-session-heading"
      className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-y-auto pb-3"
    >
      <div className="mb-3 mt-3 flex items-center gap-2.5">
        <button className="text-meta text-muted hover:text-fg" onClick={() => onNavigate(sessionsPath)} type="button">
          ← Sessions
        </button>
        <h1 className="m-0 text-title font-semibold tracking-tight" id="new-session-heading">
          New session
        </h1>
      </div>

      <Card>
        <PanelBody className="space-y-5">
          <SessionField
            hint="the wrapper or account that will run this session"
            inputId={fieldId('agent')}
            label="Account"
          >
            <input
              className="kt-input w-full font-mono"
              id={fieldId('agent')}
              onChange={event => update('agent', event.target.value)}
              placeholder="claude-auto-loge"
              value={draft.agent}
            />
          </SessionField>

          <SessionField hint="working directory for the session" inputId={fieldId('cwd')} label="Project">
            <input
              className="kt-input w-full font-mono"
              id={fieldId('cwd')}
              onChange={event => update('cwd', event.target.value)}
              placeholder="/absolute/path/to/project"
              value={draft.cwd}
            />
          </SessionField>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <SessionField hint="blank = account default" inputId={fieldId('model')} label="Model override">
              <input
                className="kt-input w-full font-mono"
                id={fieldId('model')}
                onChange={event => update('model', event.target.value)}
                placeholder="e.g. gpt-5.6-sol"
                value={draft.model}
              />
            </SessionField>

            <fieldset>
              <legend className="mb-1.5 flex items-baseline gap-2">
                <span className="text-ui font-semibold text-fg">Mode</span>
                <span className="text-meta text-faint">kteam turn handling</span>
              </legend>
              <div
                aria-label="Session mode"
                className="inline-flex rounded-control border border-border bg-surface-2 p-0.5"
                role="toolbar"
              >
                {(['auto', 'interactive'] as const).map(mode => (
                  <button
                    aria-pressed={draft.mode === mode}
                    className={cn(
                      'h-control-sm rounded-control px-3 text-ui font-medium transition-colors',
                      draft.mode === mode ? 'bg-surface text-fg shadow-control' : 'text-muted hover:text-fg',
                    )}
                    key={mode}
                    onClick={() => setDraft(current => ({ ...current, mode }))}
                    type="button"
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <SessionField hint="optional — groups related sessions" inputId={fieldId('label')} label="Label">
            <input
              className="kt-input w-full"
              id={fieldId('label')}
              onChange={event => update('label', event.target.value)}
              placeholder="e.g. kteam-ui"
              value={draft.label}
            />
          </SessionField>

          <SessionField
            hint={
              draft.mode === 'interactive' ? 'leave empty to open the TUI at its prompt' : 'the task for this teammate'
            }
            inputId={fieldId('prompt')}
            label={draft.mode === 'interactive' ? 'Opening message (optional)' : 'Opening prompt'}
          >
            <Textarea
              id={fieldId('prompt')}
              onChange={event => update('prompt', event.target.value)}
              placeholder={draft.mode === 'interactive' ? '(optional) first message…' : 'Describe the task…'}
              rows={6}
              value={draft.prompt}
            />
          </SessionField>

          {error ? (
            <div
              className="rounded-control border border-err-border bg-err-bg px-control-x py-row-y text-ui text-err"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-sm">
            <Button onClick={() => onNavigate(sessionsPath)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => void submit()} type="button" variant="primary">
              {submitting ? 'Creating…' : 'Create session'}
            </Button>
          </div>
        </PanelBody>
      </Card>
    </main>
  );
}

interface SessionFieldProps {
  readonly label: string;
  readonly hint: string;
  readonly inputId: string;
  readonly children: ReactNode;
}

function SessionField({ label, hint, inputId, children }: SessionFieldProps) {
  return (
    <div className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <label className="text-ui font-semibold text-fg" htmlFor={inputId}>
          {label}
        </label>
        <span className="text-meta text-faint">{hint}</span>
      </span>
      {children}
    </div>
  );
}
