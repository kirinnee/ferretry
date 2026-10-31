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
 *    completes, so there is nothing for a person to bring back. {@link decideCodexSubmit} says so in
 *    words rather than failing quietly — while a device code is showing, the one thing a person can
 *    send is "use a link instead".
 * 3. **The provider states its own expiry**, fifteen minutes at the time of reading. The flow's own
 *    deadline is the service's and is independent: a flow that outlived the code would leave a child
 *    polling for a grant that can no longer complete.
 *
 * ## `--device-auth` is UNDOCUMENTED, and this flow has to survive its removal
 *
 * At 0.145.0 `codex login --help` lists `--device-auth` with an **empty description**. A flag nobody
 * documents can disappear without a deprecation, so this flow is built to fail as ITSELF when it does:
 * no URL and no code recognised means the service ends the flow saying this host's harness did not offer
 * a remotable login, and names `fy credential signin`. What must not happen is a hang, or a bare exit code.
 *
 * ## Device codes can be turned off, so there is a SECOND sign-in
 *
 * An account or workspace can disable device-code sign-in. Codex then prints (quoted from the binary,
 * 0.145.0 and 0.156.1; not reachable without such an account) `device code login is not enabled for
 * this Codex server. Use the browser login or verify the server URL.` — and from a browser there would
 * be no way in at all. So this flow also runs Codex's ordinary browser login, `codex login`, whose
 * return trip is the address the provider redirected to. `./codex-link.ts` owns that address; this
 * file owns the stages:
 *
 * - **automatically**, when Codex says it could not get a device code at all ({@link observeCodexLine}
 *   moves to `device-unavailable` and the service relaunches); except on a host that shares
 *   its loopback ports (`browserPorts` is not `random`), where the link's one fixed port could be held or
 *   watched by another user, so the flow ends instead ({@link codexSharedHostEnding}) and the person chooses;
 * - **by choice**, when the person says the device code did not work ({@link decideCodexSubmit}).
 *
 * The method switches inside ONE flow, so the step-up its start was held behind is not asked twice.
 *
 * ## Everything here is PURE
 *
 * A stage in, a stage out. The child, the clock and the deadline belong to the service.
 */
import type { CodexLoginFlow, HarnessLoginLastCode, HarnessLoginSubmitRequest } from '@ferretry/protocol';
import { HarnessLoginUserCodeSchema, HarnessLoginVerificationUrlSchema } from '@ferretry/protocol';
import {
  CODEX_CALLBACK_PORTS,
  type CodexCallbackTarget,
  codexCallbackDelivery,
  codexCallbackTargetIn,
} from './codex-link.ts';
import { stripTerminalEscapes, verificationUrlIn } from './output.ts';
import type { CodexSubmitDecision, HarnessLoginFlowBase } from './ports.ts';

/** What to run after the harness command (and the credential's own arguments), for a device code. */
export const CODEX_LOGIN_ARGV: readonly string[] = ['login', '--device-auth'];

/** What to run for the link sign-in: Codex's ordinary browser login, with no flag. */
export const CODEX_LINK_LOGIN_ARGV: readonly string[] = ['login'];

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
  | {
      readonly stage: 'awaiting-approval';
      readonly verificationUrl: string;
      readonly userCode: string;
      /** Codex said it stopped waiting for this code. Never published: the exit that follows is. */
      readonly timedOut?: true;
    }
  /** Codex could not get a device code at all. Never published: the service moves on to a link. */
  | { readonly stage: 'device-unavailable' }
  /**
   * The link sign-in is running and has printed nothing usable yet. `automatic` says the daemon chose
   * it because device codes were unavailable; `portsBusy` holds Codex saying it could not listen, so
   * the exit that follows can name the cause.
   */
  | { readonly stage: 'linking'; readonly automatic?: true; readonly portsBusy?: true }
  | {
      readonly stage: 'awaiting-callback';
      readonly verificationUrl: string;
      readonly callback: CodexCallbackTarget;
      readonly automatic?: true;
    }
  /** The address reached Codex, which is redeeming it. Another address cannot follow. */
  | { readonly stage: 'finishing' }
  | { readonly stage: 'complete' }
  | CodexLoginFailure;

/** How a Codex login ended badly. `lastCode` is set only when the one-time code is why. */
export interface CodexLoginFailure {
  readonly stage: 'failed';
  readonly reason: string;
  readonly remedy: string;
  readonly lastCode?: HarnessLoginLastCode;
}

/** Where every Codex login starts: running, with neither value yet. */
export const CODEX_LOGIN_START: CodexLoginStage = { stage: 'collecting' };

/** Where a Codex login asked for as a link starts. */
export const CODEX_LINK_START: CodexLoginStage = { stage: 'linking' };

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
 * What Codex prints when it gives up polling for a device grant nobody approved.
 *
 * Quoted from the installed CLI (codex-cli 0.156.1: `device auth timed out after 15 minutes`, printed
 * after `Error logging in with device code: `). Matched as a substring because it follows that prefix;
 * nothing else Codex prints contains it. Its other device failure, `device auth failed with status …`,
 * is deliberately NOT recognised: a status code is not evidence of why, and the ordinary ending already
 * says the sign-in failed.
 */
const CODEX_TIMED_OUT = 'device auth timed out';

/**
 * What Codex prints when it could not get a device code at all — the three ways its device request
 * fails before any code exists, quoted from the binary (0.145.0, 0.156.1). The first is the explicit
 * "turned off" answer. The other two carry a status or a transport error: which status a workspace
 * policy answers with is not documented, and a link sign-in is the right next step for every one of
 * them, so all three move the flow on rather than ending it.
 */
const CODEX_DEVICE_UNAVAILABLE: readonly string[] = [
  'device code login is not enabled',
  'device code request failed with status',
  'failed to request device code',
];

/** What Codex prints when neither of its two callback ports is free (codex-cli 0.145.0, measured). */
const CODEX_PORT_BUSY = /Port 127\.0\.0\.1:\d+ is already in use/u;

/**
 * The stage one raw output line moves this flow to.
 *
 * Both values are validated through the SHARED wire schemas before they are held, and a line that
 * yields neither leaves the stage untouched and is dropped. Once a stage has published, later output is
 * the child's own polling chatter and cannot move it — except Codex saying it stopped waiting, which
 * is held (not published) so the exit that follows can say the code expired rather than just "failed".
 */
export function observeCodexLine(stage: CodexLoginStage, rawLine: string): CodexLoginStage {
  if (stage.stage === 'awaiting-approval') {
    return stripTerminalEscapes(rawLine).includes(CODEX_TIMED_OUT) ? { ...stage, timedOut: true } : stage;
  }
  if (stage.stage === 'linking') return observeLinkLine(stage, stripTerminalEscapes(rawLine));
  if (stage.stage !== 'collecting') return stage;
  const line = stripTerminalEscapes(rawLine);
  if (CODEX_DEVICE_UNAVAILABLE.some(phrase => line.includes(phrase))) return { stage: 'device-unavailable' };

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
 * The link sign-in's printed output: its authorize URL, or Codex saying it could not listen.
 *
 * The URL must be on a host this flow trusts AND name a callback it can deliver to — see
 * {@link codexCallbackTargetIn}. A URL that fails either is dropped like any other unrecognised line.
 */
function observeLinkLine(stage: Extract<CodexLoginStage, { stage: 'linking' }>, line: string): CodexLoginStage {
  if (CODEX_PORT_BUSY.test(line)) return { ...stage, portsBusy: true };
  const found = verificationUrlIn(line, CODEX_VERIFICATION_HOSTS);
  const checked = found === undefined ? undefined : HarnessLoginVerificationUrlSchema.safeParse(found);
  if (checked?.success !== true) return stage;
  const callback = codexCallbackTargetIn(checked.data);
  if (callback === undefined) return stage;
  return {
    stage: 'awaiting-callback',
    verificationUrl: checked.data,
    callback,
    ...(stage.automatic === true ? { automatic: true as const } : {}),
  };
}

/** A device-code flow that could not get a code moves to a link, which the service launches. */
export function codexAutomaticLink(): CodexLoginStage {
  return { stage: 'linking', automatic: true };
}

/**
 * How a flow ends when Codex could not get a device code and this host shares its loopback ports.
 *
 * On a host where `browserPorts` is not `random`, other local users are expected, and the link sign-in
 * listens on one host-wide port (`localhost:1455`, then 1457) that any of them can hold or watch. So
 * the daemon does NOT move to it by itself there: the device code stays the default and the link is
 * something a person picks, knowing why. The reason and the remedy are the only place the person is told.
 */
export function codexSharedHostEnding(): CodexLoginFailure {
  return {
    stage: 'failed',
    reason: `Codex could not get a device code, and the link sign-in listens on port ${CODEX_CALLBACK_PORTS.join(' or ')}, which every user on this shared host shares, so it was not started on its own`,
    remedy:
      'Ask for a device code again later, or choose the link sign-in yourself if you accept that another user on this host could block it.',
  };
}

/**
 * What a person sent to a Codex flow, and what may be done with it.
 *
 * Two things can be sent. "Use a link instead" is allowed while a device code is in play (the service
 * kills that child and launches the link sign-in). An ADDRESS is allowed only while the link sign-in waits
 * for one; it is checked here against the callback Codex printed, and the answer is the one request that
 * delivers it — never the address itself in any refusal.
 *
 * `refused` rather than an error, and worded as information: during a device code the person is not
 * doing the wrong thing, they are doing it in the right place.
 */
export function decideCodexSubmit(stage: CodexLoginStage, request: HarnessLoginSubmitRequest): CodexSubmitDecision {
  if (stage.stage === 'complete') return { decision: 'conflict', reason: 'this login has already finished' };
  if (stage.stage === 'failed') {
    return { decision: 'conflict', reason: `this login is no longer running: ${stage.reason}` };
  }
  if ('method' in request) {
    if (stage.stage === 'collecting' || stage.stage === 'awaiting-approval') return { decision: 'switch' };
    return { decision: 'conflict', reason: 'this sign-in is already using a link' };
  }
  if (stage.stage === 'awaiting-callback') {
    const check = codexCallbackDelivery(request.code, stage.callback);
    return check.kind === 'deliver'
      ? { decision: 'deliver', delivery: check.delivery }
      : { decision: 'refused', reason: check.reason };
  }
  if (stage.stage === 'finishing') {
    return { decision: 'conflict', reason: 'Codex already has the address and is finishing the sign-in' };
  }
  if (stage.stage === 'linking' || stage.stage === 'device-unavailable') {
    return {
      decision: 'refused',
      reason: 'this sign-in has not shown its link yet, so there is no address to bring back',
    };
  }
  return {
    decision: 'refused',
    reason:
      'Codex signs in with a device code: enter the one-time code at the provider’s page. There is nothing to bring back here.',
  };
}

/** The stage once the address is on its way to Codex. Set BEFORE the delivery, so a second one conflicts. */
export function codexDelivering(): CodexLoginStage {
  return { stage: 'finishing' };
}

/**
 * How this login ends when the one-time code is why, or nothing when the ordinary ending applies.
 *
 * `expired`, never `rejected`: a device grant takes no code back, so nothing was refused — the code was
 * simply no longer being waited for, because the daemon's window closed or Codex itself gave up. Either
 * way the next action is the same one: a new sign-in, which prints a new code.
 */
export function codexEnding(
  stage: CodexLoginStage,
  cause: 'window' | { readonly exit: number },
): CodexLoginFailure | undefined {
  if (stage.stage === 'linking' || stage.stage === 'awaiting-callback' || stage.stage === 'finishing') {
    return codexLinkEnding(stage, cause);
  }
  if (stage.stage !== 'awaiting-approval') return undefined;
  if (cause !== 'window' && (cause.exit === 0 || stage.timedOut !== true)) return undefined;
  return {
    stage: 'failed',
    reason: 'the one-time code expired before it was approved',
    remedy: 'Start a new sign-in to get a new code, then enter it on the provider’s page.',
    lastCode: 'expired',
  };
}

/** How a link sign-in ends when the address, its window or the host's ports are why. */
function codexLinkEnding(
  stage: Extract<CodexLoginStage, { stage: 'linking' | 'awaiting-callback' | 'finishing' }>,
  cause: 'window' | { readonly exit: number },
): CodexLoginFailure | undefined {
  if (stage.stage === 'linking') {
    if (cause === 'window' || cause.exit === 0 || stage.portsBusy !== true) return undefined;
    return {
      stage: 'failed',
      reason: `Codex could not listen for the sign-in, because ports ${CODEX_CALLBACK_PORTS.join(' and ')} on this machine are already in use by another program`,
      remedy:
        'Stop the program using them (often a local proxy), then start a new sign-in — or sign in with a device code instead.',
    };
  }
  if (stage.stage === 'awaiting-callback') {
    if (cause !== 'window') return undefined;
    return {
      stage: 'failed',
      reason: 'the sign-in link expired before its address came back',
      remedy: 'Start a new sign-in, open the new link, and paste the address it leads to.',
      lastCode: 'expired',
    };
  }
  if (cause === 'window' || cause.exit === 0) return undefined;
  return {
    stage: 'failed',
    reason: 'Codex could not finish signing in with that address',
    remedy: 'Start a new sign-in, and paste the address from that newest attempt.',
    lastCode: 'rejected',
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
  if (stage.stage === 'awaiting-callback') {
    return {
      harness: 'codex',
      ...base,
      state: 'awaiting-callback',
      verificationUrl: stage.verificationUrl,
      ...(stage.automatic === true ? { deviceCode: 'unavailable' as const } : {}),
    };
  }
  if (stage.stage === 'finishing') {
    return { harness: 'codex', ...base, state: 'finishing' };
  }
  if (stage.stage === 'complete') {
    return { harness: 'codex', ...base, state: 'complete' };
  }
  if (stage.stage === 'failed') {
    return {
      harness: 'codex',
      ...base,
      state: 'failed',
      reason: stage.reason,
      remedy: stage.remedy,
      ...(stage.lastCode === undefined ? {} : { lastCode: stage.lastCode }),
    };
  }
  // `collecting`, `device-unavailable` and `linking` are all reported as `starting`: the wire's word
  // for "running, nothing to act on yet". A partially-collected device grant, or a link sign-in that has
  // not printed its link, is exactly that, and giving each a state of its own would put a half-usable
  // screen on the wire for a reader to render.
  return { harness: 'codex', ...base, state: 'starting' };
}
