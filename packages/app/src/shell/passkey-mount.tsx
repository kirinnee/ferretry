import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PairedDaemon } from '../daemons/daemon-list.ts';
import type { PasskeyAsk } from '../passkey/passkey.ts';
import { useOptionalShell } from './context.tsx';

/**
 * WHERE THE ONE PASSKEY PROMPT IS DRAWN (G105), and which machine it may come from (G95).
 *
 * Mounted once by the frame, where today's `App.tsx` mounted its two `StepUpDialog`s: Access's prompts (the step-up and
 * the unlock) sit over every page, so a refusal from ANY plugin's call opens them. The shell draws nothing of its own
 * here — no prompt words, no button — it only places Access's and tells it the machine on screen.
 *
 * A PROMPT COMES FROM THE MACHINE ON SCREEN: the one the route names or, on a page that names none, the selected one.
 * Every other machine's background reads wait for it rather than raise a prompt over this machine's page.
 */
export function PasskeyMount({ onScreen }: { readonly onScreen: string | null }) {
  const shell = useOptionalShell();
  const provision = shell?.runtime.passkey();
  const handler = provision?.handler;
  useEffect(() => {
    handler?.focus(onScreen);
  }, [handler, onScreen]);
  if (provision === undefined) return null;
  const { Prompts } = provision;
  return <Prompts />;
}

const NOTHING_LOCKED: readonly string[] = Object.freeze([]);
const unsubscribed = () => () => {};

/**
 * Every machine with a request waiting on an unlock, for a list that shows it as locked (today's `useLockedMachines`).
 * Empty outside a shell, or when Access gave no passkey handler.
 *
 * GAP(access): nothing consumes this yet (G95). The update dot asks locked machines too, where today it skipped them
 * (rebuild-ref App.tsx:1099 `useLockedMachines`), and the settings machine rows and the machine switcher
 * (App.tsx:1961, :2637) do not mark a locked machine either. Drawing them is the app shell's and Access's, not Gate's.
 */
export function useLockedDaemons(): readonly string[] {
  const handler = useOptionalShell()?.runtime.passkey()?.handler;
  return useSyncExternalStore(
    handler === undefined ? unsubscribed : handler.subscribe,
    () => handler?.locked() ?? NOTHING_LOCKED,
    () => handler?.locked() ?? NOTHING_LOCKED,
  );
}

/**
 * The app's ONE passkey prompt, as a function a screen calls before a press (today's `useStepUpRequest`): `true` once
 * confirmed, `false` when dismissed or for a daemon this device has not paired. `undefined` when nothing can ask
 * (outside a shell, or Access gave no handler), and a screen then offers no passkey control.
 */
export function usePasskeyAsk(): ((daemon: string, request: PasskeyAsk) => Promise<boolean>) | undefined {
  const shell = useOptionalShell();
  const runtime = shell?.runtime;
  const handler = runtime?.passkey()?.handler;
  const ask = useCallback(
    async (daemon: string, request: PasskeyAsk): Promise<boolean> => {
      const paired: PairedDaemon | undefined = runtime?.daemons.get(daemon);
      return handler !== undefined && paired !== undefined ? await handler.ask(paired, request) : false;
    },
    [handler, runtime],
  );
  return handler === undefined ? undefined : ask;
}
