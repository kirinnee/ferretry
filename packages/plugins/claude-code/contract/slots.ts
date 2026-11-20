/**
 * THE SLOT CLAUDE CODE OFFERS ON ITS FIRST-RUN "SIGN IN" PAGE (r10 O7).
 *
 * The sign-in itself is Logins': it drives the harness's own login and holds no token. Claude Code only offers the
 * place, so it imports nothing of Logins; Logins' contract writes the same literal and its suite pins the pair. The
 * props are plain: `{ onSignedIn() }`, and nothing comes back but "signed in".
 */
export const CLAUDE_CODE_SIGN_IN_SLOT = 'claude-code.sign-in' as const;
