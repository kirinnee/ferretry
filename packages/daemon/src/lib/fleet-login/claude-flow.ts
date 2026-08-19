/**
 * Claude's own remote login. Nothing here is shared with Codex, and that is the design.
 *
 * ## What this flow actually is, observed rather than inferred
 *
 * Read by running `claude auth login --claudeai` with **piped** stdio at claude-code 2.1.220:
 *
 *     Opening browser to sign in…
 *     If the browser didn't open, visit: <OSC8 link>https://claude.com/cai/oauth/authorize?…<OSC8 end>
 *     Paste code here if prompted >
 *
 * Three facts follow, and each one shapes this file:
 *
 * 1. **The paste prompt is reached with piped stdio.** That is the entire remote leg: the daemon does
 *    not have to make the harness do anything new, only stop inheriting a terminal.
 * 2. **There is no localhost callback in this path.** `redirect_uri` is
 *    `https://platform.claude.com/oauth/code/callback` — a hosted page that SHOWS the reader a code. So
 *    what comes back is a CODE off a web page, not a redirected address, and a surface that asked for
 *    "the URL you were redirected to" would be describing a different flow.
 * 3. **The code is PKCE-bound, and this can now be cited.** The printed URL carries
 *    `code_challenge=…&code_challenge_method=S256`, so the verifier is inside this child and the daemon
 *    could not redeem the code it forwards even if it kept one. `docs/design/harness-login.md` §4.2
 *    recorded this as an assumption it could not cite; the observation above is the citation.
 *
 * ## Why the argv is `auth login` and not `/login`
 *
 * `packages/fleet/src/adapters/process-login.ts` launches `<wrapper> /login`, which hands a slash
 * command to the interactive TUI. That is right for a person at a terminal and it is not what was
 * verified above. `auth login` is the subcommand observed to print a URL and read a paste with piped
 * stdio, so the daemon-side flow uses it. **The CLI path is not changed** — it keeps inheriting a
 * terminal and stays the fallback for everything this flow cannot do.
 *
 * `--claudeai` is explicit rather than left to the default: an account declared `auth: 'oauth'` is a
 * subscription account, and `--console` is the API-billing login, which is a different credential for a
 * kind of account this flow never applies to.
 *
 * ## Everything here is PURE
 *
 * A stage in, a stage out. The child, the clock, the deadline and the write all belong to the service,
 * so nothing in this module can hold output, hold a code, or reach a running program. The one value a
 * person brings back never enters this file at all: `decideClaudeSubmit` answers whether a write is
 * allowed
 * and the service performs it, which is what makes "the submitted value is write-only" a property of
 * the shape rather than a rule somebody has to remember.
 */
import type { ClaudeLoginFlow, FleetLoginAccountOutcome } from '@ferretry/protocol';
import { HarnessLoginVerificationUrlSchema } from '@ferretry/protocol';
import { stripTerminalEscapes, verificationUrlIn } from './output.ts';
import type { HarnessLoginFlowBase, HarnessLoginSubmitDecision } from './ports.ts';

/** What to run after the account's own wrapper path. */
export const CLAUDE_LOGIN_ARGV: readonly string[] = ['auth', 'login', '--claudeai'];

/**
 * Hosts whose sign-in page this flow will send a person to.
 *
 * Declared, and deliberately short. `claude.com` is what 2.1.220 prints; `claude.ai` and
 * `anthropic.com` are the same product's other names. A URL on any other host is not published — see
 * {@link verificationUrlIn} for why that refusal is worth more than the convenience of accepting
 * anything a child prints.
 */
export const CLAUDE_VERIFICATION_HOSTS: readonly string[] = ['claude.com', 'claude.ai', 'anthropic.com'];

/**
 * What one Claude login is waiting for.
 *
 * Four stages, and none of them is a device code: Claude has no device grant, so there is no state in
 * which a person types a code at the provider rather than bringing one back.
 */
export type ClaudeLoginStage =
  | { readonly stage: 'starting' }
  | { readonly stage: 'awaiting-code'; readonly verificationUrl: string }
  | { readonly stage: 'complete'; readonly accounts: readonly FleetLoginAccountOutcome[] }
  | { readonly stage: 'failed'; readonly reason: string; readonly remedy: string };

/** Where every Claude login starts. */
export const CLAUDE_LOGIN_START: ClaudeLoginStage = { stage: 'starting' };

/**
 * The stage one raw output line moves this flow to.
 *
 * The URL is validated through the SHARED wire schema before it is held rather than after: a value the
 * daemon would not be allowed to publish is a value it must not hold as though it could. A line that
 * yields nothing leaves the stage exactly as it was and is dropped — never stored, never journaled.
 *
 * Only `starting` is advanced. Output after the URL is published is Claude's own prompt text and
 * progress chatter, and a second recognised URL would move a flow a person is already acting on.
 */
export function observeClaudeLine(stage: ClaudeLoginStage, rawLine: string): ClaudeLoginStage {
  if (stage.stage !== 'starting') return stage;
  const found = verificationUrlIn(stripTerminalEscapes(rawLine), CLAUDE_VERIFICATION_HOSTS);
  if (found === undefined) return stage;
  const checked = HarnessLoginVerificationUrlSchema.safeParse(found);
  return checked.success ? { stage: 'awaiting-code', verificationUrl: checked.data } : stage;
}

/**
 * Whether the person's value may be written to the child now.
 *
 * The three refusals are three different next actions. `refused` before a URL is published means "wait,
 * there is nothing to bring back yet"; `conflict` on a settled flow means "this login is over, start
 * another"; and neither is a retry invitation the way a bare failure would read.
 */
export function decideClaudeSubmit(stage: ClaudeLoginStage): HarnessLoginSubmitDecision {
  if (stage.stage === 'complete') return { decision: 'conflict', reason: 'this login has already finished' };
  if (stage.stage === 'failed') {
    return { decision: 'conflict', reason: `this login is no longer running: ${stage.reason}` };
  }
  if (stage.stage === 'starting') {
    return {
      decision: 'refused',
      reason: 'this login has not published a sign-in link yet, so there is nothing to bring a code back for',
    };
  }
  return { decision: 'write' };
}

/** The wire projection for this stage, in Claude's own state names. */
export function claudeProjection(base: HarnessLoginFlowBase, stage: ClaudeLoginStage): ClaudeLoginFlow {
  if (stage.stage === 'awaiting-code') {
    return { harness: 'claude', ...base, state: 'awaiting-code', verificationUrl: stage.verificationUrl };
  }
  if (stage.stage === 'complete') {
    return { harness: 'claude', ...base, state: 'complete', accounts: stage.accounts };
  }
  if (stage.stage === 'failed') {
    return { harness: 'claude', ...base, state: 'failed', reason: stage.reason, remedy: stage.remedy };
  }
  return { harness: 'claude', ...base, state: 'starting' };
}
