import type { LoginBudget } from './wire.ts';

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

/**
 * THE SLOT LOGINS OFFERS ON EACH LOGIN'S CARD AND PAGE (§5.2: plugin screens offer their own, named `<plugin>.<name>`).
 *
 * Under a login's quota bars: where the login stands against its spend budget (v4 drew "$/day" and "$/week" bars
 * there). The budget, its meter and its wording are Usage's (docs/budgets.md), and Logins cannot import Usage, so the
 * card OFFERS this slot and mounts whatever panel an installed plugin contributes; with none, or with no budget on the
 * login, nothing is drawn. The panel's `subject` is the login's id. The props are plain data.
 */
export const LOGIN_METER_SLOT = 'logins.login-meter' as const;

/** What the login-meter slot hands its panels, besides the shell's `subject` (the login's id). */
export interface LoginMeterSlotProps {
  /** The login's budget and where it stands, as the daemon's list carries it. */
  readonly budget: LoginBudget;
  /** The machine's name, which the spend is said to be on ("Spent on <machine> only"). */
  readonly machineName: string;
}

/**
 * THE TWO SLOTS LOGINS FILLS IN A HARNESS'S FIRST-RUN SEGMENT (r10 O7/O10).
 *
 * Claude Code and Codex each offer one (`claude-code.sign-in`, `codex.sign-in`) on their own "Sign in" onboarding page;
 * Logins draws the sign-in there, because the sign-in is Logins'. Neither harness is imported here (they need Logins'
 * words, not the other way round), so the names are literals and each harness's own suite pins the same literal. The
 * props are plain: `{ onSignedIn() }` and nothing comes back but "signed in" — no token, code or address ever reaches
 * the page that mounts the panel.
 */
export const CLAUDE_CODE_SIGN_IN_SLOT = 'claude-code.sign-in' as const;
export const CODEX_SIGN_IN_SLOT = 'codex.sign-in' as const;
export const HARNESS_SIGN_IN_SLOTS = [CLAUDE_CODE_SIGN_IN_SLOT, CODEX_SIGN_IN_SLOT] as const;
