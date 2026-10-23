import { type AuditActor, type AuditOutcome, OPEN_URL_MAX_LENGTH, type OpenUrlView } from '@ferretry/protocol';
import type { AuditSink } from '../audit/index.ts';

/**
 * HANDING ONE WEB ADDRESS TO THIS COMPUTER'S OWN BROWSER.
 *
 * The app is often installed in one browser while its reader wants links in another — a macOS
 * default-browser router, a work profile. Only the operating system knows that choice, so the daemon,
 * which runs on the machine, gives it the address through the OS's own opener.
 *
 * ## THREE LOCKS, AND WHY EACH LIVES WHERE IT DOES
 *
 * 1. **WHERE THE CALLER IS** is the route's `privilegedOnly`, decided from the carrier the request
 *    arrived on — never from an address, a header or this body (`docs/grants.md`). A relayed, tunnelled
 *    or WebRTC caller is remote and is refused before this service runs.
 * 2. **WHAT MAY BE OPENED** is {@link parseOpenableUrl}: http and https only, no credentials. An opener
 *    will happily run `file:`, `javascript:` or a registered custom scheme, so the allow-list is the
 *    only thing standing between this route and "run something on the machine".
 * 3. **HOW OFTEN** is {@link OpenRateLimiter}. A page cannot open a hundred windows by looping.
 *
 * THE ADDRESS IS ONE ARGV ELEMENT, NEVER A SHELL STRING (see {@link openerCommand}). The validated
 * `href` is also the form the OS receives, so the bytes checked are the bytes opened.
 */

/** How many openings are allowed in one window. */
export const OPEN_URL_LIMIT = 10 as const;

/** The window the limit counts in. */
export const OPEN_URL_WINDOW_MS = 10_000 as const;

type OpenUrlRefusal = 'unreadable' | 'scheme' | 'credentials' | 'host' | 'too_long';

export type OpenableUrl =
  | { readonly ok: true; readonly href: string; readonly host: string }
  | { readonly ok: false; readonly refusal: OpenUrlRefusal; readonly message: string };

const REFUSAL_MESSAGES: Readonly<Record<OpenUrlRefusal, string>> = {
  unreadable: 'that is not a web address this computer can open',
  scheme: 'only http and https addresses can be opened in this computer’s browser',
  credentials: 'an address with a user name or password in it will not be opened',
  host: 'that address names no website',
  too_long: 'that address is too long to open',
};

const refused = (refusal: OpenUrlRefusal): OpenableUrl => ({ ok: false, refusal, message: REFUSAL_MESSAGES[refusal] });

/**
 * Whether a raw string is an address the daemon will hand to the operating system, and the normalised
 * form it will hand over.
 *
 * Whitespace and control characters are refused outright rather than normalised: the WHATWG parser
 * silently deletes tabs and newlines inside a URL, and an address that changes meaning between the
 * check and the open is exactly the gap this function exists to close.
 */
export function parseOpenableUrl(raw: string): OpenableUrl {
  if (raw.length > OPEN_URL_MAX_LENGTH) return refused('too_long');
  if (raw !== raw.trim() || /[\p{Cc}\p{Cf}\s]/u.test(raw)) return refused('unreadable');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused('unreadable');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return refused('scheme');
  if (url.username !== '' || url.password !== '') return refused('credentials');
  if (url.hostname === '') return refused('host');
  if (url.href.length > OPEN_URL_MAX_LENGTH) return refused('too_long');
  return { ok: true, href: url.href, host: url.hostname };
}

/** One executable and its argument vector. Nothing here is ever joined into a string. */
export interface OpenerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The operating system's opener for one address.
 *
 * - macOS `open <url>`, which hands it to the default browser (and so to any router in front of it).
 * - Linux and the other Unixes `xdg-open <url>`.
 * - Windows `rundll32 url.dll,FileProtocolHandler <url>`: the same entry point the shell uses, and
 *   unlike `cmd /c start` it never passes through the command interpreter, which would re-read `&`,
 *   `^` and `%` inside an address that arrived as a single argument.
 *
 * `href` must come from {@link parseOpenableUrl}: it begins `http`, so no opener can read it as an option.
 */
export function openerCommand(platform: NodeJS.Platform, href: string): OpenerCommand {
  if (platform === 'darwin') return { command: 'open', args: [href] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', href] };
  return { command: 'xdg-open', args: [href] };
}

/** At most `limit` openings in any `windowMs`, counted for the whole daemon. */
export class OpenRateLimiter {
  private readonly times: number[] = [];

  constructor(
    private readonly limit: number = OPEN_URL_LIMIT,
    private readonly windowMs: number = OPEN_URL_WINDOW_MS,
  ) {}

  /** Counts one attempt, or answers how long until one would be allowed. */
  take(nowMs: number): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
    const cutoff = nowMs - this.windowMs;
    while (this.times.length > 0 && (this.times[0] ?? 0) <= cutoff) this.times.shift();
    const oldest = this.times[0];
    if (this.times.length >= this.limit && oldest !== undefined)
      return { allowed: false, retryAfterMs: oldest + this.windowMs - nowMs };
    this.times.push(nowMs);
    return { allowed: true };
  }
}

/** Starts a program and lets go of it: no output is read and nothing waits for it to finish. */
export interface DetachedLauncherPort {
  launch(command: OpenerCommand): Promise<void>;
}

export type OpenUrlErrorCode = 'invalid_url' | 'rate_limited' | 'opener_failed';

export class OpenUrlError extends Error {
  constructor(
    readonly code: OpenUrlErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OpenUrlError';
  }
}

export interface OpenUrlPorts {
  readonly launcher: DetachedLauncherPort;
  readonly audit: AuditSink;
  readonly nowMs: () => number;
  readonly platform: NodeJS.Platform;
  readonly limiter?: OpenRateLimiter;
}

/** Audit subjects are one short line; a host is at most 253 characters, so one is clipped to fit. */
const SUBJECT_MAX = 160;

/** The route is reachable only by a caller on this machine, so the actor is always the host. */
const LOCAL_ACTOR: AuditActor = { kind: 'host' };

export class OpenUrlService {
  private readonly limiter: OpenRateLimiter;

  constructor(private readonly ports: OpenUrlPorts) {
    this.limiter = ports.limiter ?? new OpenRateLimiter();
  }

  /**
   * Opens one address, or throws {@link OpenUrlError}. Every outcome is recorded as `link.opened`,
   * by HOST only: the path and query of a link routinely carry a token or a private page's name.
   */
  async open(raw: string): Promise<OpenUrlView> {
    const taken = this.limiter.take(this.ports.nowMs());
    if (!taken.allowed) {
      await this.record('refused', undefined, { reason: 'rate-limited' });
      throw new OpenUrlError(
        'rate_limited',
        'too many links were opened just now; wait a moment',
        Math.max(1, Math.ceil(taken.retryAfterMs / 1000)),
      );
    }
    const parsed = parseOpenableUrl(raw);
    if (!parsed.ok) {
      await this.record('refused', undefined, { reason: parsed.refusal });
      throw new OpenUrlError('invalid_url', parsed.message);
    }
    try {
      await this.ports.launcher.launch(openerCommand(this.ports.platform, parsed.href));
    } catch {
      await this.record('failed', parsed.host, { reason: 'opener-unavailable' });
      throw new OpenUrlError('opener_failed', 'this computer has no way to open a link right now');
    }
    await this.record('succeeded', parsed.host, {});
    return { opened: true, host: parsed.host };
  }

  private async record(
    outcome: AuditOutcome,
    host: string | undefined,
    detail: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.ports.audit.record({
      event: 'link.opened',
      actor: LOCAL_ACTOR,
      outcome,
      ...(host === undefined ? {} : { subject: host.slice(0, SUBJECT_MAX) }),
      ...(Object.keys(detail).length === 0 ? {} : { detail }),
    });
  }
}
