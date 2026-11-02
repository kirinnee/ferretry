import { LOGIN_USERNAME_MAX_LENGTH } from '@ferretry/protocol';

/**
 * WHO A PAGE IS SIGNING IN, as the daemon saw the ferret type it (docs/input-requests.md, "Who is signing in").
 *
 * When a ferret's own `browser.type` puts text into an identifier field (an email or username box, as the browser
 * worker classified the field it typed into), the daemon keeps that text for that ONE page and the host of the
 * document the field was in. A password card raised on the same page and host later reads it as `typedUsername`.
 *
 * What it is: PLAIN text the ferret already held and typed itself, so keeping it tells the ferret nothing and puts no
 * secret anywhere. What it is NOT: proof of anything. A ferret can type whatever it likes, so the card uses it only to
 * pre-fill the owner's editable "Username" under "Save as" and to REMOVE a one-tap whose account is someone else.
 * Nothing here ever chooses, promotes or fills an account.
 *
 * It is forgotten when the page is seen on another host, after {@link TYPED_IDENTITY_TTL_MS}, when a later type
 * replaces it, and when the session ends. It lives in memory only.
 */

/** How long a typed username stays the page's: long enough for a slow owner, short enough not to name a later sign-in. */
export const TYPED_IDENTITY_TTL_MS = 15 * 60_000;
/** The most pages remembered per session: a bound, not a feature. */
const MAX_PAGES_PER_SESSION = 32;

interface Typed {
  readonly host: string;
  readonly username: string;
  readonly at: number;
}

/** Whether `text` can be kept as a username: one line, not empty, not too long, no control or format characters. */
export function usernameOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > LOGIN_USERNAME_MAX_LENGTH || /[\p{Cc}\p{Cf}]/u.test(trimmed)) return undefined;
  return trimmed;
}

export class TypedIdentities {
  /** Per session, per page id (the browser's own, never a name a closed page could hand on), what was typed there. */
  private readonly pages = new Map<string, Map<string, Typed>>();

  constructor(private readonly now: () => number) {}

  /** The ferret typed `text` into an identifier field on page `pageId`, in a document on `host`. */
  typed(sessionId: string, pageId: string, host: string, text: string): void {
    const username = usernameOf(text);
    const own = this.pages.get(sessionId) ?? new Map<string, Typed>();
    own.delete(pageId);
    if (username !== undefined) own.set(pageId, { host: host.toLowerCase(), username, at: this.now() });
    while (own.size > MAX_PAGES_PER_SESSION) own.delete(own.keys().next().value as string);
    if (own.size === 0) this.pages.delete(sessionId);
    else this.pages.set(sessionId, own);
  }

  /** The page was seen on `host` after an act: what was typed on another host is not who it signs in now. */
  seen(sessionId: string, pageId: string, host: string | undefined): void {
    const own = this.pages.get(sessionId);
    const kept = own?.get(pageId);
    if (own === undefined || kept === undefined) return;
    if (host !== undefined && kept.host === host.toLowerCase()) return;
    own.delete(pageId);
    if (own.size === 0) this.pages.delete(sessionId);
  }

  /** The username typed on page `pageId` in a document on `host`, while it is fresh; else `undefined`. */
  at(sessionId: string, pageId: string, host: string | undefined): string | undefined {
    const kept = this.pages.get(sessionId)?.get(pageId);
    if (kept === undefined || host === undefined || kept.host !== host.toLowerCase()) return undefined;
    const age = this.now() - kept.at;
    return age >= 0 && age <= TYPED_IDENTITY_TTL_MS ? kept.username : undefined;
  }

  /** The sessions it remembers anything about. */
  sessions(): readonly string[] {
    return [...this.pages.keys()];
  }

  /** A session ended: nothing about it is kept. */
  forget(sessionId: string): void {
    this.pages.delete(sessionId);
  }
}
