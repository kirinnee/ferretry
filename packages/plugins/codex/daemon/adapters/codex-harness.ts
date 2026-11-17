/**
 * Codex as a harness (§4.3): the value of `harnesses:codex`.
 *
 * It finds the binary and its version (never its sign-in files), writes a ferret's home in Codex's own format, builds
 * the launch argv, and starts, resumes and stops through whichever runner Ferrets hands it. It never reads
 * `auth.json`: an OAuth login's file is linked into the home by the kernel from Logins' shared credential
 * (`LaunchSpec.credential` -> `RootHandle.linkCredential`), and an environment login arrives as the Vault's
 * `ChildEnvironment`, which this code passes on unopened.
 *
 * The members live in `../harness/parts/`, one part per concern, listed in that folder's registry; this file only
 * composes them. A new member goes into a part, never here.
 */
import { harnessContext, type CodexHarness, type CodexHarnessOptions } from '../harness/parts/context.ts';
import { CODEX_HARNESS_PARTS } from '../harness/parts/list.ts';

export type { CodexHarness, CodexHarnessOptions };

type Intersection<Union> = (Union extends unknown ? (member: Union) => void : never) extends (member: infer All) => void
  ? All
  : never;

/** What the registered parts add up to; a member no part provides makes `complete` below fail to compile. */
type Composed = Intersection<ReturnType<(typeof CODEX_HARNESS_PARTS)[number]>>;
const complete = (composed: Composed): CodexHarness => composed;

export function codexHarness(options: CodexHarnessOptions): CodexHarness {
  const context = harnessContext(options);
  return complete(Object.assign({}, ...CODEX_HARNESS_PARTS.map(part => part(context))) as Composed);
}
