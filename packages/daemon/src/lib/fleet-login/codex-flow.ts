/**
 * Codex's own remote login. Nothing here is shared with Claude, and that is the design.
 *
 * ## What this flow actually is, observed rather than inferred
 *
 * Read by running `codex login --device-auth` with **piped** stdio at codex-cli 0.145.0:
 *
 *     Follow these steps to sign in with ChatGPT using device code authorization:
 *
 *     1. Open this link in your browser and sign in to your account
 *        https://auth.openai.com/codex/device
 *
 *     2. Enter this one-time code (expires in 15 minutes)
 *        0IER-FFQW6
 *
 * Three facts follow, and each one shapes this file:
 *
 * 1. **TWO values, on two different lines, and the flow needs both.** A device grant is useless with
 *    only one of them: a URL with no code sends a person to a page that asks for one, and a code with no
 *    URL is a string nobody can spend. So this flow has a partial stage — it holds whichever arrived
 *    first — and publishes nothing until it has the pair. Claude's flow has no equivalent, which is one
 *    of the reasons the two are not one flow.
 * 2. **There is no return trip.** The child polls the provider itself and exits when the grant
 *    completes, so there is nothing for a person to bring back and no submission that could ever be
 *    accepted. {@link decideCodexSubmit} says so in words rather than failing quietly.
 * 3. **The provider states its own expiry**, fifteen minutes at the time of reading. The flow's own
 *    deadline is the service's and is independent: a flow that outlived the code would leave a child
 *    polling for a grant that can no longer complete.
 *
 * ## `--device-auth` is UNDOCUMENTED, and this flow has to survive its removal
 *
 * At 0.145.0 `codex login --help` lists `--device-auth` with an **empty description**. A flag nobody
 * documents can disappear without a deprecation, so this flow is built to fail as ITSELF when it does:
 * no URL and no code recognised means the service ends the flow saying this host's harness did not offer
 * a remotable login, and names `fy fleet login`. What must not happen is a hang, or a bare exit code.
 *
 * ## Everything here is PURE
 *
 * A stage in, a stage out. The child, the clock and the deadline belong to the service.
 */
import type { CodexLoginFlow, FleetLoginAccountOutcome } from '@ferretry/protocol';
import { HarnessLoginUserCodeSchema, HarnessLoginVerificationUrlSchema } from '@ferretry/protocol';
import { stripTerminalEscapes, verificationUrlIn } from './output.ts';
import type { HarnessLoginFlowBase, HarnessLoginSubmitDecision } from './ports.ts';

/** What to run after the account's own wrapper path. */
export const CODEX_LOGIN_ARGV: readonly string[] = ['login', '--device-auth'];

/**
 * Hosts whose sign-in page this flow will send a person to.
 *
 * `auth.openai.com` is what 0.145.0 prints; `chatgpt.com` is the same account's other front door. Any
 * other host is dropped rather than published.
 */
export const CODEX_VERIFICATION_HOSTS: readonly string[] = ['openai.com', 'chatgpt.com'];

/**
 * What one Codex login is waiting for.
 *
 * `collecting` is the stage that exists because two values arrive separately. It is not an error state
 * and not a published one: the flow is running, the provider has printed part of what a person needs,
 * and publishing half of it would produce a screen that cannot be acted on.
 */
export type CodexLoginStage =
  | {
      readonly stage: 'collecting';
      readonly verificationUrl?: string;
      readonly userCode?: string;
    }
  | { readonly stage: 'awaiting-approval'; readonly verificationUrl: string; readonly userCode: string }
  | { readonly stage: 'complete'; readonly accounts: readonly FleetLoginAccountOutcome[] }
  | { readonly stage: 'failed'; readonly reason: string; readonly remedy: string };

/** Where every Codex login starts: running, with neither value yet. */
export const CODEX_LOGIN_START: CodexLoginStage = { stage: 'collecting' };

/**
 * A device user code, if this line is one and nothing else.
 *
 * The whole trimmed line must BE the code. Requiring that rather than searching inside the line is what
 * stops the sentence "Enter this one-time code" contributing a match, and it is what the observed output
 * actually looks like: the code sits alone on its own indented line.
 */
function userCodeIn(line: string): string | undefined {
  const parsed = HarnessLoginUserCodeSchema.safeParse(line.trim());
  return parsed.success ? parsed.data : undefined;
}

/**
 * The stage one raw output line moves this flow to.
 *
 * Both values are validated through the SHARED wire schemas before they are held, and a line that
 * yields neither leaves the stage untouched and is dropped. Once a stage has published, later output is
 * the child's own polling chatter and cannot move it.
 */
export function observeCodexLine(stage: CodexLoginStage, rawLine: string): CodexLoginStage {
  if (stage.stage !== 'collecting') return stage;
  const line = stripTerminalEscapes(rawLine);

  const found = verificationUrlIn(line, CODEX_VERIFICATION_HOSTS);
  const checkedUrl = found === undefined ? undefined : HarnessLoginVerificationUrlSchema.safeParse(found);
  const verificationUrl = checkedUrl?.success === true ? checkedUrl.data : stage.verificationUrl;
  const userCode = userCodeIn(line) ?? stage.userCode;

  if (verificationUrl !== undefined && userCode !== undefined) {
    return { stage: 'awaiting-approval', verificationUrl, userCode };
  }
  // Returned UNCHANGED when this line moved nothing, rather than rebuilt. A stage that came back as a
  // fresh object every line would make "was this line dropped?" unanswerable by identity, which is the
  // one question a reader of a recogniser most wants to ask.
  if (verificationUrl === stage.verificationUrl && userCode === stage.userCode) return stage;
  return {
    stage: 'collecting',
    ...(verificationUrl === undefined ? {} : { verificationUrl }),
    ...(userCode === undefined ? {} : { userCode }),
  };
}

/**
 * A submission, which Codex never has one of.
 *
 * `refused` rather than an error, and worded as information: the person is not doing the wrong thing,
 * they are doing it in the right place. A surface that showed a paste box here would be asking for a
 * value this harness has no way to receive.
 */
export function decideCodexSubmit(stage: CodexLoginStage): HarnessLoginSubmitDecision {
  if (stage.stage === 'complete') return { decision: 'conflict', reason: 'this login has already finished' };
  if (stage.stage === 'failed') {
    return { decision: 'conflict', reason: `this login is no longer running: ${stage.reason}` };
  }
  return {
    decision: 'refused',
    reason:
      'Codex signs in with a device code: enter the one-time code at the provider’s page. There is nothing to bring back here.',
  };
}

/** The wire projection for this stage, in Codex's own state names. */
export function codexProjection(base: HarnessLoginFlowBase, stage: CodexLoginStage): CodexLoginFlow {
  if (stage.stage === 'awaiting-approval') {
    return {
      harness: 'codex',
      ...base,
      state: 'awaiting-approval',
      verificationUrl: stage.verificationUrl,
      userCode: stage.userCode,
    };
  }
  if (stage.stage === 'complete') {
    return { harness: 'codex', ...base, state: 'complete', accounts: stage.accounts };
  }
  if (stage.stage === 'failed') {
    return { harness: 'codex', ...base, state: 'failed', reason: stage.reason, remedy: stage.remedy };
  }
  // `collecting` is reported as `starting`: the wire's word for "running, nothing to act on yet". A
  // partially-collected device grant is exactly that, and giving it a state of its own would put a
  // half-usable screen on the wire for a reader to render.
  return { harness: 'codex', ...base, state: 'starting' };
}
