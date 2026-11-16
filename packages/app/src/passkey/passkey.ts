import type { ComponentType } from 'react';
import type { ShellPluginClient } from '../client/daemon-client.ts';
import type { DaemonList, PairedDaemon } from '../daemons/daemon-list.ts';

/**
 * WHEN A DAEMON WANTS A PASSKEY, THE SHELL ASKS ONCE AND SENDS AGAIN ONCE (G105, `docs/design/zero-trust.md` B1).
 *
 * A machine that wants a passkey on opening answers every request `401 unlock_required`; an act that needs a recent
 * step-up answers `403 grant_step_up_required`. Neither is a failure: the daemon allowed the act and wants its owner to
 * confirm. Every plugin's call goes through the one per-daemon client (`client/daemon-client.ts`), so the client is
 * where that pause is taken — once, for every plugin, with no change in any of them:
 *
 * 1. the refusal is shown to the {@link PasskeyHandler} (Access's app half), which says whether it is a passkey need
 *    at all — the shell reads no code and parses no body of its own;
 * 2. the handler raises its ONE prompt and answers `true` once the person has confirmed and the daemon accepted it;
 * 3. the same request is sent again exactly once. A dismissed prompt returns the refusal unchanged, and a second
 *    refusal of the same kind is the answer. The unlock comes first — while it is wanted nothing else can be read —
 *    then a step-up for the act, each at most once.
 *
 * A READ IS THE PAGE'S OWN WORK (G95): a `GET` or `HEAD` is `background`, and its prompt waits until its machine is
 * on screen ({@link PasskeyHandler.focus}); anything else is a press, `explicit`, and asks at once.
 *
 * NOTHING HERE HOLDS A CREDENTIAL (G100). A verified step-up is a fact the DAEMON remembers about this device and this
 * copy of the app; no challenge, assertion or proof crosses this seam, and nothing here is logged.
 *
 * Only Access may provide the handler (like its device claims, {@link PASSKEY_TAKERS}): the passkeys, the unlock and
 * the ceremony are Access's (§2.3), and a second implementation would be a second prompt.
 */

/** The one plugin whose passkey handler the shell takes. */
export const PASSKEY_TAKERS: readonly string[] = Object.freeze(['access']);

/**
 * Who started the request that needs a passkey: a person pressing something (`explicit`), or a page reading in the
 * background (`background`). Only the first may raise a prompt for a machine that is not on screen.
 */
export type PromptOrigin = 'explicit' | 'background';

/** What a request's method says about who started it: a read is the page's own work, anything else a press. */
export const requestOrigin = (method: string): PromptOrigin => {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' ? 'background' : 'explicit';
};

/** A daemon's refusal as the client received it: its status and its whole, unparsed body. */
export interface PasskeyRefusal {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Which passkey a refusal waits on, as the handler read it. `act` is the phrase the prompt names ("open a terminal");
 * `actId` the act the daemon named, for the handler to re-read — both absent when the daemon named none.
 */
export type PasskeyNeed =
  | { readonly kind: 'unlock' }
  | { readonly kind: 'step-up'; readonly act?: string; readonly actId?: string };

/**
 * What a bound passkey shows, as STRUCTURE (the daemon's one plain line, its label/value rows, the red warnings and the
 * amber cautions). Nothing is split out of text, so a row can never land in the warnings.
 */
export interface PasskeyWords {
  readonly does: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly warnings: readonly string[];
  readonly cautions?: readonly string[];
}

/**
 * A step-up asked BEFORE a press (today's `useStepUpRequest`): the same one prompt, never a second. With only `act`
 * it is the machine's ordinary window; with `actId` (and, for an act bound to one staged thing — a sign-in rule, a
 * paste rule, a task plan, a 2FA seed — its `subject`) the proof is stamped for that act alone. `actId` and
 * `subject` are the daemon's own names, re-read by the handler, which refuses (answers `false`) anything it cannot
 * parse rather than ask unbound.
 */
export interface PasskeyAsk {
  readonly actId?: string;
  /** The phrase the prompt names; absent, the prompt says "this change". */
  readonly act?: string;
  /** The staged id the proof is bound to. */
  readonly subject?: string;
  readonly words?: PasskeyWords;
}

/** Access's side of the seam: reads a refusal, raises the one prompt, and says which machines wait on an unlock. */
export interface PasskeyHandler {
  /** Whether this refusal is a passkey need, and which. `undefined` is any other refusal, returned as it came. */
  need(refusal: PasskeyRefusal): PasskeyNeed | undefined;
  /** Raises the one prompt for this machine; `true` once the person confirmed and the daemon accepted it. */
  confirm(daemon: PairedDaemon, need: PasskeyNeed, origin: PromptOrigin): Promise<boolean>;
  /** A bound step-up asked before a press ({@link PasskeyAsk}); always `explicit`. */
  ask(daemon: PairedDaemon, request: PasskeyAsk): Promise<boolean>;
  /** The machine on screen, or `null` for a page that shows none: its waiting background requests may now ask. */
  focus(daemon: string | null): void;
  /** Every machine with a request waiting on an unlock — the machines a list shows as locked. Stable between changes. */
  locked(): readonly string[];
  subscribe(listener: () => void): () => void;
}

/**
 * What the composition root hands the provider (`src/main.tsx`): Access's own guarded client on a daemon (the
 * ceremony's routes are Access's), the paired daemons (to name a machine apart from its twins), this copy of the app's
 * origin (the passkey's relying party) and the browser's credential container. Never a transport, never a fetch.
 */
export interface PasskeyPorts {
  /** Access's client on this daemon, or `undefined` while the shell cannot reach it (or Access is paused there). */
  readonly client: (daemon: string) => ShellPluginClient | undefined;
  readonly daemons: Pick<DaemonList, 'snapshot' | 'subscribe'>;
  readonly origin: string;
  readonly credentials: Pick<CredentialsContainer, 'create' | 'get'>;
}

/** What the provider gives: the handler the client consults, and the prompts the shell mounts once at its root. */
export interface PasskeyProvision {
  readonly handler: PasskeyHandler;
  /** The step-up prompt and the unlock prompt, mounted where every page is drawn (`shell/passkey-mount.tsx`). */
  readonly Prompts: ComponentType;
}
