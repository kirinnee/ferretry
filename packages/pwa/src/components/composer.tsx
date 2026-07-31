import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { IFyApiClient } from '@ferretry/protocol';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionScope } from '../lib/daemon-scope.ts';
import { DaemonDraftStore } from '../lib/drafts.ts';
import { canSubmitComposer, composerUsesEnterToSend } from '../lib/session-screens.ts';

export interface ComposerProps {
  readonly daemon: DaemonConnection;
  readonly sessionId: string;
  readonly api: Pick<IFyApiClient, 'send'>;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly draftStore?: DaemonDraftStore;
  readonly onSent?: () => void;
}

const defaultDraftStore = new DaemonDraftStore();

/**
 * A single composer surface. Draft persistence is scoped by the supplied paired
 * daemon and session, and its API client is injected by the host for the same
 * reason: no bundled origin, token, or singleton daemon exists here.
 */
export function Composer({
  daemon,
  sessionId,
  api,
  busy = false,
  disabled = false,
  placeholder = 'Message this session',
  draftStore = defaultDraftStore,
  onSent,
}: ComposerProps) {
  const scope = useMemo(() => daemonSessionScope(daemon, sessionId), [daemon, sessionId]);
  const [draft, setDraft] = useState(() => draftStore.load(scope));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const hintId = useId();

  useEffect(() => {
    setDraft(draftStore.load(scope));
    setError(null);
  }, [daemon.daemonId, draftStore, scope]);

  useEffect(() => {
    const timer = setTimeout(() => draftStore.save(scope, draft), 400);
    return () => clearTimeout(timer);
  }, [draft, draftStore, scope]);

  const submit = async () => {
    if (!canSubmitComposer(draft, disabled, sending) || submitLock.current) return;
    submitLock.current = true;
    setSending(true);
    setError(null);
    try {
      await api.send(sessionId, { message: draft.trim(), now: !busy });
      setDraft('');
      draftStore.clear(scope);
      onSent?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message could not be sent');
    } finally {
      submitLock.current = false;
      setSending(false);
    }
  };

  return (
    <form
      aria-describedby={hintId}
      className="fy-composer"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor={`${hintId}-input`}>
        Message
      </label>
      <textarea
        disabled={disabled || sending}
        id={`${hintId}-input`}
        onChange={event => setDraft((event.currentTarget as unknown as { value: string }).value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || (event.nativeEvent as { isComposing?: boolean }).isComposing)
            return;
          const matchMedia = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia;
          const pointerFine = matchMedia?.('(pointer: fine)').matches ?? false;
          const canHover = matchMedia?.('(hover: hover)').matches ?? false;
          if (!composerUsesEnterToSend(pointerFine, canHover)) return;
          event.preventDefault();
          void submit();
        }}
        placeholder={placeholder}
        rows={1}
        value={draft}
      />
      <div className="fy-composer-actions">
        <p id={hintId}>{busy ? 'Queue for the next turn' : 'Enter to send · Shift+Enter for a new line'}</p>
        <button disabled={!canSubmitComposer(draft, disabled, sending)} type="submit">
          {sending ? 'Sending…' : busy ? 'Queue' : 'Send'}
        </button>
      </div>
      {error ? (
        <p className="fy-composer-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
