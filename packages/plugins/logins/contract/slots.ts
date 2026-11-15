/**
 * THE SLOTS LOGINS FILLS ON RUNTIMES' ADD RUNTIME PAGE.
 *
 * Runtimes owns the two names and their props (its contract/slots.ts: `runtimes.add-runtime-login`, which takes
 * `{ onAdded(id) }`, and `runtimes.add-runtime-sign-in`, which takes `{ harness, onSignedIn() }` and names the login as
 * its `subject`). The names are written here because Runtimes already needs Logins, so Logins cannot import Runtimes'
 * contract; the shell's slot test pairs the two. A panel answers only with a login's id or a bare "signed in": no token
 * and no secret ever reaches the page that mounts it.
 */

/** Under the Add runtime page's login list: the add-login panel. */
export const ADD_RUNTIME_LOGIN_SLOT = 'runtimes.add-runtime-login' as const;
/** Under a picked login that needs sign-in: that login's sign-in panel. */
export const ADD_RUNTIME_SIGN_IN_SLOT = 'runtimes.add-runtime-sign-in' as const;

/** Every slot of Runtimes' page that Logins contributes a panel to. */
export const LOGINS_CONTRIBUTED_SLOTS = [ADD_RUNTIME_LOGIN_SLOT, ADD_RUNTIME_SIGN_IN_SLOT] as const;
