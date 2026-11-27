import type { DeferredAgendaActions } from './agenda-inbox.ts';

/** Internal routes keep Undo; leaving the device sends, even after the originating Inbox unmounted. */
export const watchAnswerPage = (deferred: DeferredAgendaActions): (() => void) | undefined => {
  if (typeof window === 'undefined') return undefined;
  const flush = (): void => deferred.flush();
  const hidden = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  const detach = (): void => {
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', hidden);
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    if (deferred.getSnapshot().pending.length === 0) {
      detach();
      return;
    }
    // The timer and this watcher outlive the page, until its last held answer sends or is undone.
    const off = deferred.subscribe(() => {
      if (deferred.getSnapshot().pending.length !== 0) return;
      detach();
      off();
    });
  };
};
