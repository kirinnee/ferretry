/**
 * Whether a harness has an interactive login at all — DECLARED, per harness, in one table.
 *
 * This is the narrowest of the three questions a login surface has to answer, and separating it from
 * the other two is what stops one flow being written for both harnesses:
 *
 * 1. **Does this harness do an interactive login?** Declared here. A harness that authenticates by
 *    some other means never offers one, and nothing infers the answer from a kind, a binary name or
 *    the presence of a `login` subcommand.
 * 2. **Does this ACCOUNT's credential come from a login?** That is
 *    {@link ./credential-source.ts}, and it is a different question with a different answer: a
 *    harness that logs in perfectly well still has nothing to log in when the account's key arrives
 *    from a file or the environment.
 * 3. **How does the login actually run?** That is per harness and it lives with each harness's own
 *    flow, never here. Claude prints a URL and reads a pasted code from stdin; Codex completes a
 *    device grant at the provider and needs no return trip. Those are two programs, two output
 *    shapes and two state machines, and a table that tried to parameterise them would be the shared
 *    abstraction the two flows are deliberately not built on.
 *
 * So the declaration carries no argv, no flags and no output patterns. It carries the one fact a
 * surface needs before it can decide whether to show anything at all.
 *
 * **The `false` arm is a slot, not dead weight.** Both harnesses this build ships log in, so nothing
 * in production constructs it today. It exists because the alternative is a consumer that assumes
 * every harness logs in — and the day a harness that does not is added, the assumption would be
 * invisible while this table makes it a compile error. The table is annotated
 * `Readonly<Record<HarnessKind, …>>` rather than inferred, so adding a harness kind fails to compile
 * until somebody declares its answer; `satisfies` would have accepted the omission.
 */
import type { HarnessKind } from './manifest.ts';

/**
 * What one harness declares about its own interactive login.
 *
 * Discriminated rather than a boolean with an optional reason: a harness that does not log in owes
 * the reader a sentence, and a shape that let it be omitted would produce a surface that says
 * nothing — which reads as a broken control rather than as a harness that has no login.
 */
export type HarnessLoginDeclaration =
  | { readonly login: true }
  | {
      readonly login: false;
      /** Why this harness has no interactive login, in words a person can act on. */
      readonly reason: string;
    };

/** Every harness's answer. Total by annotation: a new kind cannot be left undeclared. */
export type HarnessLoginDeclarations = Readonly<Record<HarnessKind, HarnessLoginDeclaration>>;

/**
 * The shipped declarations.
 *
 * Both are `true`, and both were established by reading the installed CLIs rather than their `--help`
 * output — see `docs/migration/surveys/harness-login-flows.md`. `claude auth login`'s flag surface
 * alone would have said "not possible".
 */
export const HARNESS_LOGIN_DECLARATIONS: HarnessLoginDeclarations = {
  claude: { login: true },
  codex: { login: true },
};

/**
 * Whether this harness does an interactive login.
 *
 * The table is a parameter with the shipped one as its default. That is not ceremony: it is the only
 * way a consumer can be PROVEN to honour a `login: false` declaration on a build whose every harness
 * logs in, and a consumer nobody can prove honours it is a consumer that quietly does not.
 */
export function harnessDoesInteractiveLogin(
  kind: HarnessKind,
  declarations: HarnessLoginDeclarations = HARNESS_LOGIN_DECLARATIONS,
): boolean {
  return declarations[kind].login;
}

/** Why this harness has no interactive login, or `undefined` when it has one. */
export function harnessNoLoginReason(
  kind: HarnessKind,
  declarations: HarnessLoginDeclarations = HARNESS_LOGIN_DECLARATIONS,
): string | undefined {
  const declaration = declarations[kind];
  return declaration.login ? undefined : declaration.reason;
}
