import { HealthViewSchema } from '@ferretry/protocol';

/** The non-restartable exit code used when another daemon of this product already owns the address. */
export const EXIT_ALREADY_RUNNING = 78;

/**
 * The non-restartable exit code for an address held by a responder that is NOT one of these daemons.
 *
 * A SECOND code, because the remedy is a different one. "The daemon you asked for is already running"
 * needs nothing done at all; "something else owns this port" needs a human to choose another address
 * or stop the other program, and a supervisor that respawned into it would loop against a condition
 * no restart can clear. Both are therefore listed as restart-preventing in the service definitions.
 */
export const EXIT_ADDRESS_CONFLICT = 69;

/**
 * The three host capabilities a boot needs, declared where the boot policy lives.
 *
 * They used to sit in a `readiness.ts` beside a copy of the CLI's readiness decision table. That
 * table was the daemon waiting for a daemon to come up, which is not something this process ever
 * does — `fy daemon start` is the only caller there has ever been, and `packages/cli` owns its own
 * copy because the split forbids it importing this package. The table went with the waiter that
 * used it; these ports stayed, because the probe, the binder and every clock-reading route are real.
 */
export interface DaemonFetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface MillisecondClockPort {
  now(): number;
}

export interface SleepPort {
  sleep(milliseconds: number): Promise<void>;
}

export interface BindRetryPolicy {
  readonly backoffMs: number;
  readonly totalMs: number;
  readonly maxAttempts: number;
}

export const defaultBindRetryPolicy = (): BindRetryPolicy => ({ backoffMs: 500, totalMs: 30_000, maxAttempts: 61 });

/** Builds the health endpoint without retaining any trailing slash. */
export function healthEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/v1/health`;
}

/** A bind conflict is transient only while another owner may still be draining. */
export function shouldRetryBind(
  error: unknown,
  nowMs: number,
  deadlineMs: number,
  attempts: number,
  policy: BindRetryPolicy,
): boolean {
  return isAddressInUse(error) && attempts < policy.maxAttempts && nowMs + policy.backoffMs <= deadlineMs;
}

function isAddressInUse(error: unknown): boolean {
  return (
    (error as { readonly code?: unknown } | null)?.code === 'EADDRINUSE' ||
    /EADDRINUSE|address already in use/iu.test(String(error))
  );
}

/**
 * What ONE probe of the address observed, reported without judging it.
 *
 * The split is between a connection that was actively REFUSED — the kernel answering for a port
 * nothing holds — and every other failure, which proves nothing about whether the address is free.
 * A timeout, a reset mid-response or a TLS error all mean the probe could not finish, and a probe
 * that could not finish is not evidence of a vacant address.
 */
export type AddressProbeOutcome =
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unreachable'; readonly detail: string };

/**
 * WHO holds the address a daemon is about to bind.
 *
 * `stranger` covers both "identified as something else" and "could not be identified at all", and
 * that is deliberate: the two deserve the same refusal, because the danger is identical. What
 * separates them is the `evidence` string, which says exactly what was seen so a human can tell a
 * 401 from an unrelated web server from a probe that timed out.
 */
export type AddressOccupant =
  | { readonly kind: 'vacant' }
  | { readonly kind: 'daemon'; readonly version: string; readonly pid: number }
  | { readonly kind: 'stranger'; readonly evidence: string };

/**
 * Who is answering, decided from what the probe saw.
 *
 * "SOMETHING ANSWERED" IS NOT "I AM ALREADY RUNNING", and treating it as one is the defect this
 * function exists to close: a supervisor for a different fleet answered the probe with a 401, the
 * boot read that as its own incumbent, and exited. Identification is therefore positive — the
 * responder must serve this product's own health report, over twenty required fields the protocol
 * schema checks — and anything short of that is a stranger.
 *
 * IT FAILS CLOSED. Only an actively refused connection clears the way; an answer that does not
 * identify itself, and a probe that could not complete, are both refusals to boot. Booting a second
 * daemon over a live one because identification was inconclusive is the one outcome that cannot be
 * recovered from, since both then own state neither can see the other writing.
 */
export function identifyAddressOccupant(outcome: AddressProbeOutcome): AddressOccupant {
  if (outcome.kind === 'refused') return { kind: 'vacant' };
  if (outcome.kind === 'unreachable')
    return {
      kind: 'stranger',
      evidence: `the address is held but did not answer the health probe (${outcome.detail})`,
    };
  const identity = HealthViewSchema.safeParse(outcome.body);
  if (outcome.status !== 200 || !identity.success)
    return {
      kind: 'stranger',
      evidence: `it answered the health probe with HTTP ${String(outcome.status)} and a body this product does not publish`,
    };
  return { kind: 'daemon', version: identity.data.version, pid: identity.data.pid };
}

/**
 * Where a boot states something a human must read.
 *
 * A PORT, because the refusals below are the one thing this daemon says outside its own API, and the
 * decision about what to say must be provable without a running daemon writing to a real file. The
 * composition root sends it to the standard error stream, which every service definition appends to
 * the daemon's log — so a refusal now reaches exactly the file the launcher tells the operator to read.
 */
export interface BootNoticePort {
  state(message: string): void;
}

/** A boot that will not continue: what a human is told, and what the exit code says. */
export interface BootRefusal {
  readonly exitCode: number;
  readonly message: string;
}

/** Everything a refusal names, so no part of the message is assembled from a global. */
export interface OccupiedAddressReport {
  /** The daemon executable's own name, as it introduces itself in its log. */
  readonly daemonName: string;
  /** The command a human drives, so the message can name the verb that stops the incumbent. */
  readonly clientName: string;
  /** The address this boot was about to bind. */
  readonly url: string;
  /** The configuration document whose `port` chooses a different one. */
  readonly configFile: string;
  readonly occupant: Exclude<AddressOccupant, { readonly kind: 'vacant' }>;
}

/**
 * How a boot answers an address that already has an owner.
 *
 * A NON-ZERO EXIT THAT EXPLAINS NOTHING IS A BUG, not terseness. This whole surface used to return
 * 78 and write not one byte, so the launcher told the operator to inspect a log file that was empty
 * — a person who had done everything right was left with no information at all. Every branch here
 * says what was found, where, and what to do about it.
 */
export function refuseOccupiedAddress(report: OccupiedAddressReport): BootRefusal {
  const choose = `choose a different address by setting "port" in ${report.configFile}, then start again`;
  if (report.occupant.kind === 'daemon')
    return {
      exitCode: EXIT_ALREADY_RUNNING,
      message: `${report.daemonName} ${report.occupant.version} (pid ${String(report.occupant.pid)}) is already serving ${report.url}, so this one has nothing to do and is exiting. Stop the running one with \`${report.clientName} daemon stop\`, or ${choose}.`,
    };
  return {
    exitCode: EXIT_ADDRESS_CONFLICT,
    message: `${report.url} is already taken by something that is not a ${report.daemonName}: ${report.occupant.evidence}. That may be another agent supervisor, an unrelated service, or a daemon too broken to answer — this boot cannot tell, and it will not fight a live listener for the address. Stop whatever holds ${report.url}, or ${choose}.`,
  };
}

/**
 * How a boot answers a state home another owner already holds.
 *
 * The SAME defect as the address refusal above and fixed for the same reason: this returned 78 in
 * silence one line before it, so the two indistinguishable outcomes were both an empty log.
 */
export function refuseHeldStateHome(daemonName: string, clientName: string, lockFile: string): BootRefusal {
  return {
    exitCode: EXIT_ALREADY_RUNNING,
    message: `another ${daemonName} already owns this state home — its lifetime lock ${lockFile} is held, and one state home may only ever have one owner. Stop the running one with \`${clientName} daemon stop\`, or point this one at its own state home with FY_HOME.`,
  };
}

/**
 * What a boot says when the address it advertises is not the address it binds.
 *
 * A DEPLOYMENT MAY MEAN THIS — a daemon behind a reverse proxy advertises the proxy's name and binds
 * loopback — so it is a notice rather than a refusal. It exists because the far more common cause was
 * a defect: the derived public URL used to be written back into the configuration document as though
 * an operator had chosen it, after which editing `port` moved the bind and left the advertisement
 * pointing at the old address. Nothing is derived into that file any more, but the homes written
 * before the fix still carry the stale value, and a stale advertisement hands out a pairing link
 * nothing answers.
 */
export function foreignAdvertisementNotice(bindUrl: string, publicUrl: string, configFile: string): string {
  return `this daemon binds ${bindUrl} but advertises ${publicUrl}; pairing links and browser origins will name the advertised address. If that is not deliberate, remove "publicUrl" from ${configFile} and it will follow "port" again.`;
}
