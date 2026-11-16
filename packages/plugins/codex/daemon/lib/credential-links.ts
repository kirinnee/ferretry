/**
 * What takes a login's sign-in back out of a ferret's home. The link is made at a launch and stays until the harness
 * removes it (`RootHandle.linkCredential`), so this plugin removes it when the ferret ends or the login is revoked.
 * The agent runs as the same user and can read the linked file while it is there (docs/secrets.md): this ends the link,
 * it does not hide it.
 */
export interface CodexCredentialLinks {
  /** A ferret stopped or went away: its home holds no sign-in. */
  released(ferret: string): Promise<void>;
  /** A login was removed, signed out or switched off: every home this plugin linked it into holds no sign-in. */
  revoked(login: string): Promise<void>;
}

/** The changes of a login that take its sign-in away; the others (an edit, a status look, a switch on) leave it. */
const REVOKING: ReadonlySet<string> = new Set(['removed', 'signed-out', 'disabled']);

/**
 * The two events Codex listens to. A ferret that stopped (or is gone) has its home cleared; a login that was removed,
 * signed out or switched off has every home it was linked into cleared. Nothing else touches a home.
 */
export function followCredentialEnds(links: CodexCredentialLinks) {
  return {
    'ferrets.changed': async (change: { readonly ferret: string; readonly state?: string; readonly gone?: true }) => {
      if (change.gone === true || change.state === 'stopped') await links.released(change.ferret);
    },
    'logins.changed': async (change: { readonly loginId: string; readonly change: string }) => {
      if (REVOKING.has(change.change)) await links.revoked(change.loginId);
    },
  };
}
