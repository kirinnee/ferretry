/**
 * A HOST COMPOSER for the Inbox's reply box (`AgendaComposerContext`). The real composer is Conversation's and this
 * half never imports it; the suites bind this one instead. It keeps what the Agenda relies on a composer for: one
 * draft per item (`draftSlot`), the words of a taken-back reply put back once (`restore`), Send through the api it is
 * handed (empty only when `allowEmptySend`), the sent words reported (`onSent`), a refusal shown under the box and
 * cleared when `clearErrorOn` changes, and a mic only when dictation settings are passed.
 */

import { type ReactElement, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import {
  AgendaComposerContext,
  type AgendaComposerProps,
} from '../../../app/features/agenda/agenda-inbox-composer.tsx';

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const publish = (): void => {
  version += 1;
  for (const listener of listeners) listener();
};

/** Every draft the host composer holds, per machine, ferret and item. */
export const fakeComposerDrafts = {
  read: (key: string): string => drafts.get(key) ?? '',
  write: (key: string, text: string): void => {
    if (text === '') drafts.delete(key);
    else drafts.set(key, text);
    publish();
  },
  /** Forgets every draft of one ferret on one machine. */
  clear: (scope: { readonly daemonId: string; readonly sessionId: string }): void => {
    const prefix = JSON.stringify([scope.daemonId, scope.sessionId]).slice(0, -1);
    for (const key of [...drafts.keys()]) if (key.startsWith(prefix)) drafts.delete(key);
    publish();
  },
};

const keyOf = (props: AgendaComposerProps): string =>
  JSON.stringify([props.daemon.daemonId, props.sessionId, props.draftSlot]);

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : 'The message was not sent.');

export function FakeComposer(props: AgendaComposerProps): ReactElement {
  const key = keyOf(props);
  useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  const draft = fakeComposerDrafts.read(key);
  const [error, setError] = useState<string | null>(null);
  const { restore, onRestored, clearErrorOn } = props;
  useEffect(() => {
    if (restore === undefined) return;
    fakeComposerDrafts.write(key, restore);
    onRestored?.();
  }, [key, restore, onRestored]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of `clearErrorOn` is the only trigger
  useEffect(() => setError(null), [clearErrorOn]);

  const submit = async (): Promise<void> => {
    const words = draft;
    if (props.disabled || (words.trim() === '' && !props.allowEmptySend)) return;
    try {
      const answer = (await props.api.send(props.sessionId, { message: words })) as
        | { readonly sendId?: string; readonly disposition?: string }
        | undefined;
      setError(null);
      fakeComposerDrafts.write(key, '');
      props.onSent?.({ words, sendId: answer?.sendId, disposition: answer?.disposition });
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return (
    <form
      className="fy-composer"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        data-live-editor=""
        disabled={props.disabled}
        onChange={event => fakeComposerDrafts.write(key, event.currentTarget.value)}
        placeholder={props.placeholder}
        value={draft}
      />
      {props.dictationSettings === undefined ? null : <button data-composer-mic="" type="button" />}
      {error === null ? null : (
        <p className="fy-composer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The Inbox with {@link FakeComposer} bound as the host's composer. */
export function WithFakeComposer({ children }: { readonly children: ReactNode }): ReactElement {
  return <AgendaComposerContext.Provider value={FakeComposer}>{children}</AgendaComposerContext.Provider>;
}
