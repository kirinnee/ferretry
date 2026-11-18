import { useRef } from 'react';
import type { PasskeyNeed } from '../passkey/passkey.ts';
import { useOptionalRouter } from '../router/router.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { routeDaemon } from './nav-targets.ts';

/** What the bar says for each passkey a machine wants, and the words on its one button. */
const WORDS: Readonly<Record<PasskeyNeed['kind'], { readonly line: string; readonly press: string }>> = {
  unlock: { line: 'This machine is locked until you confirm it’s you.', press: 'Unlock' },
  'step-up': { line: 'Part of this page needs you to confirm it’s you.', press: 'Confirm it’s you' },
};

/**
 * THE ONE PRESS FOR A PASSKEY NOBODY ASKED FOR YET (A555 r7).
 *
 * A read the person did not cause — the page loading after a reload or a deep link, a poll — raises no passkey prompt:
 * a modal nobody asked for, over the page, again and again, was the owner's "flickers ALOT". Its refusal is its answer.
 * But a refusal with no way to answer it is a dead end, and not every page draws its own "Confirm it's you". So when
 * the machine the route names refused such a read, the shell draws this one quiet line with one button: pressing it is
 * the person's act, so it opens the ONE prompt (Access's, with "Add a passkey" in it for a device that holds none), and
 * once confirmed the machine's views are built again so they read again (`ShellRuntime.confirmUnasked`).
 *
 * It is drawn IN FLOW in the frame's status strip (from `BackgroundViews`), a row under the top bar: never over the
 * header's own controls or under a phone's notch. A daemon-less screen (the pair-success screen, which offers its own
 * "Add a passkey now") gets no line.
 */
export function PasskeyBar() {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const route = useOptionalRouter()?.route;
  const busy = useRef(false);
  const daemon = route === undefined ? undefined : routeDaemon(route);
  const need = daemon === undefined ? undefined : runtime.unaskedNeed(daemon);
  if (daemon === undefined || need === undefined) return null;
  const words = WORDS[need.kind];
  // Never disabled: the prompt hands focus back to this button when it closes. A second press while one is open is a no-op.
  const press = (): void => {
    if (busy.current) return;
    busy.current = true;
    void runtime.confirmUnasked(daemon).finally(() => {
      busy.current = false;
    });
  };
  return (
    <div className="fy-shell-line flex flex-wrap items-center gap-x-3 gap-y-1" data-passkey-bar={need.kind}>
      <p className="m-0 min-w-0 flex-1 text-ui leading-base text-fg">{words.line}</p>
      <button
        type="button"
        className="kt-btn shrink-0"
        data-variant="primary"
        data-passkey-bar-press=""
        onClick={press}
      >
        {words.press}
      </button>
    </div>
  );
}
