import type { AuditDraft } from '@ferretry/core-gate/contract';
import type { OwnSecret, OwnSecretRefusal, StateFileDef, StatePort } from '@ferretry/kernel/contract';
import {
  AUDIT,
  CAPTCHA_MONTHLY_CAP_MICROS,
  CAPTCHA_SPEND_FILE,
  type CaptchaSpend,
  StealthAuditDetailSchemas,
} from '../../contract/index.ts';
import type { CaptchaAnswer, CaptchaKind, CaptchaWidget } from './solver-page.ts';

export type { CaptchaKind, CaptchaWidget } from './solver-page.ts';

/**
 * SOLVING A TOKEN CHECK FOR THE OWNER (B5 D7; owner decision D-3). When the page in front of a ferret shows a Turnstile,
 * reCAPTCHA or hCaptcha box AND stealth is in effect, the daemon asks a solver service for the token the box would have
 * given a person, and the worker hands it to the widget. Everything else (a picture puzzle the agent may try itself, a
 * check no token API answers, a missing key, a spent month) stays where it was: the banner and the owner's takeover.
 *
 * WHAT STAYS WHERE:
 * - the key is `${secret:CAPSOLVER_API_KEY}`, resolved here in the daemon at the moment of a solve and sent to the vendor
 *   in the request body, never to the worker, a route, the audit log or a log line;
 * - the worker gets the TOKEN and nothing else, and answers only whether the page took it;
 * - the spend is kept in state, reserved before a task is sent and given back when it fails: a month never passes the cap.
 */

/** A proxy the solver may solve through, so the token is issued to the IP the page is seen from. */
export interface CaptchaProxy {
  readonly type: 'http' | 'https' | 'socks5';
  readonly host: string;
  readonly port: number;
  readonly login?: string;
  readonly password?: string;
}

export interface CaptchaSolveRequest {
  readonly kind: CaptchaKind;
  readonly siteKey: string;
  readonly pageUrl: string;
  /** reCAPTCHA v3's action (or Turnstile's), when the widget names one. */
  readonly action?: string;
  readonly proxy?: CaptchaProxy;
}

/** Why a solve gave no token: the month's cap, no usable key, a check this vendor cannot answer, or a failed attempt. */
export type CaptchaRefusal = 'cap' | 'no-key' | 'unsupported' | 'failed';

/** `{ token }`, or a refusal in one plain sentence (the sentence the agent and the owner read, so it names no secret). */
export type CaptchaSolveResult =
  | { readonly token: string }
  | { readonly refused: CaptchaRefusal; readonly reason: string };

/** Anything that turns a check into a token. Vendors are adapters behind it. */
export interface CaptchaSolverPort {
  readonly vendor: string;
  solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult>;
  /** Whether a solve could start now: the refusal it would give (no key, the month's cap spent), or `undefined`. */
  ready(): Promise<{ readonly refused: CaptchaRefusal; readonly reason: string } | undefined>;
}

// ─── the spend ledger ────────────────────────────────────────────────────────────────────────────────────────

/** List price of one solve in millionths of a dollar (plan §3.5, third-party snapshot; the cap is judged on these). */
export const SOLVE_COST_MICROS: Readonly<Record<CaptchaKind, number>> = {
  turnstile: 1200,
  'recaptcha-v2': 800,
  'recaptcha-v3': 1000,
  hcaptcha: 800,
};

/** A `kernel.state` that can read-modify-write a file, and nothing more. */
export type SpendState = Pick<StatePort, 'update'>;

/**
 * This month's spend, in `captcha-spend.json`. `reserve` adds a cost only if it fits under the cap (the update declines
 * otherwise, so nothing is written), and `release` gives it back when the task failed: the vendor charges only a solve.
 */
export class SpendLedger {
  constructor(
    private readonly state: SpendState,
    /** An ISO instant: its first seven characters are the month. */
    private readonly now: () => string,
    private readonly file: StateFileDef<string, CaptchaSpend> = CAPTCHA_SPEND_FILE,
  ) {}

  private month(): string {
    return this.now().slice(0, 7);
  }

  async reserve(micros: number, cap: number): Promise<'reserved' | 'cap' | 'unreadable'> {
    const month = this.month();
    let outcome: 'reserved' | 'cap' = 'cap';
    const result = await this.state.update(this.file, current => {
      const months = spendByMonth(current);
      const spent = months[month] ?? 0;
      if (spent + micros > cap) {
        outcome = 'cap';
        return current ?? { month, micros: 0 };
      }
      outcome = 'reserved';
      return packSpend({ ...months, [month]: spent + micros });
    });
    return result.ok ? outcome : 'unreadable';
  }

  async release(micros: number): Promise<void> {
    const month = this.month();
    await this.state.update(this.file, current => {
      const months = spendByMonth(current);
      return packSpend({ ...months, [month]: Math.max(0, (months[month] ?? 0) - micros) });
    });
  }

  async spent(): Promise<number> {
    let micros = 0;
    await this.state.update(this.file, current => {
      micros = spendByMonth(current)[this.month()] ?? 0;
      return current ?? { month: this.month(), micros: 0 };
    });
    return micros;
  }
}

/** The last months of spend the file keeps: a year, so the file stays small and a clock that moves back still finds its month. */
const KEPT_MONTHS = 12;

/** Every month the file holds spend for. */
function spendByMonth(current: CaptchaSpend | undefined): Readonly<Record<string, number>> {
  return current === undefined ? {} : { ...current.earlier, [current.month]: current.micros };
}

/** The file for these months: the latest as `month`/`micros` and the rest as `earlier`. */
function packSpend(months: Readonly<Record<string, number>>): CaptchaSpend {
  const kept = Object.keys(months).sort().slice(-KEPT_MONTHS);
  const latest = kept[kept.length - 1] as string;
  const earlier = Object.fromEntries(kept.slice(0, -1).map(month => [month, months[month] as number]));
  return kept.length === 1
    ? { month: latest, micros: months[latest] as number }
    : { month: latest, micros: months[latest] as number, earlier };
}

// ─── the CapSolver adapter ───────────────────────────────────────────────────────────────────────────────────

const CAPSOLVER_ORIGIN = 'https://api.capsolver.com';

export interface CapSolverPorts {
  /** `kernel.fetch`: refuses any host `permissions.network` does not name. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** `kernel.secrets.resolve`, asked for `CAPSOLVER_API_KEY` at the moment of a solve. */
  readonly secret: () => Promise<OwnSecret | { readonly refused: OwnSecretRefusal }>;
  readonly ledger: SpendLedger;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** For a test's fake server; the default is the vendor's own address. */
  readonly origin?: string;
  readonly pollMilliseconds?: number;
  readonly deadlineMilliseconds?: number;
  readonly capMicros?: number;
}

const NO_KEY: Readonly<Record<OwnSecretRefusal, string>> = {
  not_declared: 'The captcha solver has no key declared, so this build cannot use it.',
  not_configured:
    'The captcha solver is not set up: add captcha.apiKey: ${secret:CAPSOLVER_API_KEY} to browsers.yaml and store the key with `fy secret set CAPSOLVER_API_KEY`.',
  unknown:
    'The captcha solver has no key yet: store it with `fy secret set CAPSOLVER_API_KEY` (browsers.yaml already names it).',
};

const CAP_SENTENCE = (capMicros: number): string =>
  `The captcha solver has used its $${(capMicros / 1_000_000).toFixed(2)} for this month; it starts again on the 1st.`;

/** What CapSolver answers, read only for the fields this adapter uses. */
interface VendorAnswer {
  readonly errorId?: unknown;
  readonly errorCode?: unknown;
  readonly taskId?: unknown;
  readonly status?: unknown;
  readonly solution?: { readonly token?: unknown; readonly gRecaptchaResponse?: unknown };
}

type TaskSpec = { readonly type: string; readonly fields: Readonly<Record<string, unknown>> };

function proxyFields(proxy: CaptchaProxy): Readonly<Record<string, unknown>> {
  return {
    proxyType: proxy.type,
    proxyAddress: proxy.host,
    proxyPort: proxy.port,
    ...(proxy.login === undefined ? {} : { proxyLogin: proxy.login }),
    ...(proxy.password === undefined ? {} : { proxyPassword: proxy.password }),
  };
}

/** The vendor's task for a check. Turnstile is only sold proxyless; the others solve through the proxy when one is given. */
function taskFor(request: CaptchaSolveRequest): TaskSpec {
  const base = { websiteURL: request.pageUrl, websiteKey: request.siteKey };
  const via = request.proxy === undefined ? undefined : proxyFields(request.proxy);
  const suffix = via === undefined ? 'ProxyLess' : '';
  switch (request.kind) {
    case 'turnstile':
      return {
        type: 'AntiTurnstileTaskProxyLess',
        fields: { ...base, ...(request.action === undefined ? {} : { metadata: { action: request.action } }) },
      };
    case 'recaptcha-v2':
      return { type: `ReCaptchaV2Task${suffix}`, fields: { ...base, ...via } };
    case 'recaptcha-v3':
      return {
        type: `ReCaptchaV3Task${suffix}`,
        fields: { ...base, ...(request.action === undefined ? {} : { pageAction: request.action }), ...via },
      };
    case 'hcaptcha':
      return { type: `HCaptchaTask${suffix}`, fields: { ...base, ...via } };
  }
}

/** A vendor error code, only in the vendor's own shape (`ERROR_` and capitals): anything else is `UNKNOWN`, so no stray text rides into a sentence. */
const codeOf = (value: unknown): string =>
  typeof value === 'string' && /^ERROR_[A-Z0-9_]{1,40}$/u.test(value) ? value : 'UNKNOWN';

export class CapSolver implements CaptchaSolverPort {
  readonly vendor = 'capsolver';
  private readonly origin: string;
  private readonly cap: number;

  constructor(private readonly ports: CapSolverPorts) {
    this.origin = ports.origin ?? CAPSOLVER_ORIGIN;
    this.cap = ports.capMicros ?? CAPTCHA_MONTHLY_CAP_MICROS;
  }

  async ready(): Promise<{ readonly refused: CaptchaRefusal; readonly reason: string } | undefined> {
    const key = await this.ports.secret();
    if ('refused' in key) return { refused: 'no-key', reason: NO_KEY[key.refused] };
    if ((await this.ports.ledger.spent()) >= this.cap) return { refused: 'cap', reason: CAP_SENTENCE(this.cap) };
    return undefined;
  }

  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    const key = await this.ports.secret();
    if ('refused' in key) return { refused: 'no-key', reason: NO_KEY[key.refused] };
    const cost = SOLVE_COST_MICROS[request.kind];
    const reserved = await this.ports.ledger.reserve(cost, this.cap);
    if (reserved === 'cap') return { refused: 'cap', reason: CAP_SENTENCE(this.cap) };
    if (reserved === 'unreadable')
      return { refused: 'cap', reason: 'The captcha solver’s spending record could not be read, so it is not used.' };
    const { outcome, charged } = await this.run(key, request);
    // The vendor charges for a task it took: only a check it never took, or one it answered with an error, gives its reservation back.
    if ('refused' in outcome && !charged) await this.ports.ledger.release(cost).catch(() => undefined);
    return outcome;
  }

  /** One vendor call: the key is revealed here, into one request body, and nowhere else. */
  private async call(key: OwnSecret, path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await this.ports.fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: key.reveal(), ...body }),
      redirect: 'manual',
    });
    if (!response.ok) throw new Error(`status ${String(response.status)}`);
    return await response.json();
  }

  /** `charged`: the vendor took a task and did not answer with an error, so it may still finish and bill (our deadline, a lost poll, no token). */
  private async run(
    key: OwnSecret,
    request: CaptchaSolveRequest,
  ): Promise<{ readonly outcome: CaptchaSolveResult; readonly charged: boolean }> {
    let taken = false;
    const failed = (reason: string): { outcome: CaptchaSolveResult; charged: boolean } => ({
      outcome: { refused: 'failed', reason },
      charged: taken,
    });
    try {
      const task = taskFor(request);
      const created = (await this.call(key, '/createTask', {
        task: { type: task.type, ...task.fields },
      })) as VendorAnswer;
      if (created.errorId !== 0 || typeof created.taskId !== 'string')
        return failed(`The solver did not take the check (${codeOf(created.errorCode)}).`);
      taken = true;
      const deadline = this.ports.deadlineMilliseconds ?? 120_000;
      const every = this.ports.pollMilliseconds ?? 2_000;
      for (let waited = 0; waited <= deadline; waited += every) {
        await this.ports.sleep(every);
        const answer = (await this.call(key, '/getTaskResult', { taskId: created.taskId })) as VendorAnswer;
        if (answer.errorId !== 0) {
          taken = false; // the vendor itself says the task failed: it does not bill a failed task
          return failed(`The solver could not solve the check (${codeOf(answer.errorCode)}).`);
        }
        if (answer.status === 'ready') {
          const token = answer.solution?.token ?? answer.solution?.gRecaptchaResponse;
          return typeof token === 'string' && token !== ''
            ? { outcome: { token }, charged: true }
            : failed('The solver answered without a token.');
        }
      }
      return failed('The solver did not answer in time.');
    } catch {
      // The error's own words are dropped: a transport error can quote a request it was making.
      return failed('The solver could not be reached.');
    }
  }
}

// ─── what triggers it ────────────────────────────────────────────────────────────────────────────────────────

/** What the worker offers for a page: the check it shows, and a way to hand a token to it. */
export interface CaptchaPagePort {
  captchaProbe?(pageId: string): Promise<(CaptchaWidget & { readonly pageUrl: string }) | undefined>;
  captchaInject?(pageId: string, answer: CaptchaAnswer): Promise<boolean>;
}

export interface CaptchaSolvingPorts {
  /** Whether stealth is in effect for the page's identity (the machine's one agent browser: its switch in effect). */
  readonly stealth: () => boolean;
  readonly solver: CaptchaSolverPort;
  /** The page's own queue (`inputOnPage`): the probe and the inject each run in it, the vendor's wait does not. */
  readonly onPage: <T>(
    sessionId: string,
    page: string,
    work: (page: CaptchaPagePort, pageId: string) => Promise<T>,
  ) => Promise<T>;
  /** The proxy the browser goes through, when it has one the solver can be given (no credentials are read for it). */
  readonly proxy: () => CaptchaProxy | undefined;
  readonly audit: (draft: AuditDraft) => Promise<void>;
  readonly nowMs: () => number;
  /** Told of a failure to write an audit record, with no secret in it. */
  readonly failed: (message: string) => void;
}

/** What a tool call learns when a page shows a check: nothing to say, "wait, it is being solved", or why it is not. */
export type CaptchaStart =
  | { readonly kind: 'off' }
  | { readonly kind: 'solving' }
  | { readonly kind: 'solved' }
  | { readonly kind: 'not-solving'; readonly reason: string };

/** After an attempt that gave nothing, how long the same page is left alone, so a tool loop cannot spend or retry at once. */
const COOLDOWN_MS = 5 * 60_000;
const MAX_REMEMBERED_PAGES = 256;

const IDENTITY = 'agent';

/** A page left alone: until when, what a caller is told, and (for a solved check) the widget it was solved for. */
interface Remembered {
  readonly until: number;
  readonly start: CaptchaStart;
  readonly solved?: CaptchaWidget & { readonly pageUrl: string };
}

const sameWidget = (
  a: CaptchaWidget & { readonly pageUrl: string },
  b: CaptchaWidget & { readonly pageUrl: string },
): boolean => a.kind === b.kind && a.siteKey === b.siteKey && a.pageUrl === b.pageUrl;

function hostOf(address: string): string | undefined {
  try {
    const host = new URL(address).hostname.toLowerCase();
    return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

export class CaptchaSolving {
  private readonly inFlight = new Set<string>();
  /** The month a cap record was last written for, so a spent month is said once and not on every tool call. */
  private capSaid = '';
  /** Pages left alone for a while: one the solver gave up on (with why), or one it has solved (the widget's frame stays up until the form is sent). */
  private readonly coolingUntil = new Map<string, Remembered>();

  constructor(private readonly ports: CaptchaSolvingPorts) {}

  /**
   * A page shows a check (the recogniser said so). With stealth in effect: looks for a solvable widget, and if the solver
   * could start, solves in the background and says so. Never throws; a probe that fails is "not solving".
   */
  async begin(sessionId: string, pageId: string): Promise<CaptchaStart> {
    if (!this.ports.stealth()) return { kind: 'off' };
    const key = `${sessionId}\u0000${pageId}`;
    if (this.inFlight.has(key)) return { kind: 'solving' };
    const cooling = this.coolingUntil.get(key);
    if (cooling?.solved === undefined && cooling !== undefined && cooling.until > this.ports.nowMs())
      return cooling.start;
    const widget = await this.ports
      .onPage(sessionId, pageId, async (page, id) => await page.captchaProbe?.(id))
      .catch(() => undefined);
    // A solved check stays solved for as long as the page shows the same widget (its document): no clock ends it, so
    // the owner is not charged again for an answer the page already holds. A different widget is a new check.
    if (cooling?.solved !== undefined) {
      if (widget !== undefined && sameWidget(cooling.solved, widget)) return cooling.start;
      this.coolingUntil.delete(key);
    }
    if (widget === undefined)
      return this.rest(
        key,
        'The page shows a check that no token solver answers (only Turnstile, reCAPTCHA and hCaptcha boxes).',
      );
    const refusal = await this.ports.solver.ready().catch(() => undefined);
    if (refusal !== undefined) {
      if (refusal.refused === 'cap') await this.sayCapOnce();
      return this.rest(key, refusal.reason);
    }
    this.inFlight.add(key);
    void this.solve(sessionId, pageId, key, widget).finally(() => this.inFlight.delete(key));
    return { kind: 'solving' };
  }

  private rest(key: string, reason: string): CaptchaStart {
    return this.remember(key, { kind: 'not-solving', reason });
  }

  private remember(
    key: string,
    start: CaptchaStart,
    solved?: CaptchaWidget & { readonly pageUrl: string },
  ): CaptchaStart {
    this.coolingUntil.delete(key);
    // At capacity, drop what has run out first, and then only the oldest page: never the whole memory at once.
    if (this.coolingUntil.size >= MAX_REMEMBERED_PAGES) {
      const now = this.ports.nowMs();
      for (const [page, each] of this.coolingUntil)
        if (each.solved === undefined && each.until <= now) this.coolingUntil.delete(page);
    }
    if (this.coolingUntil.size >= MAX_REMEMBERED_PAGES) {
      const oldest = this.coolingUntil.keys().next();
      if (oldest.done !== true) this.coolingUntil.delete(oldest.value);
    }
    this.coolingUntil.set(key, {
      until: this.ports.nowMs() + COOLDOWN_MS,
      start,
      ...(solved === undefined ? {} : { solved }),
    });
    return start;
  }

  private async solve(
    sessionId: string,
    pageId: string,
    key: string,
    widget: CaptchaWidget & { readonly pageUrl: string },
  ): Promise<void> {
    const started = this.ports.nowMs();
    const proxy = this.ports.proxy();
    const result = await this.ports.solver
      .solve({
        kind: widget.kind,
        siteKey: widget.siteKey,
        pageUrl: widget.pageUrl,
        ...(widget.action === undefined ? {} : { action: widget.action }),
        ...(proxy === undefined ? {} : { proxy }),
      })
      .catch((): CaptchaSolveResult => ({ refused: 'failed', reason: 'The solver could not be reached.' }));
    let taken = false;
    if ('token' in result) {
      const answer: CaptchaAnswer = { kind: widget.kind, token: result.token, pageUrl: widget.pageUrl };
      taken = await this.ports
        .onPage(sessionId, pageId, async (page, id) => (await page.captchaInject?.(id, answer)) === true)
        .catch(() => false);
    }
    const outcome =
      'token' in result ? (taken ? 'solved' : 'failed') : result.refused === 'failed' ? 'failed' : 'refused';
    if (outcome === 'solved') this.remember(key, { kind: 'solved' }, widget);
    else this.rest(key, 'token' in result ? 'The page did not take the solver’s answer.' : result.reason);
    const host = hostOf(widget.pageUrl);
    if (host !== undefined)
      await this.record({
        event: AUDIT.captchaSolve,
        actor: { kind: 'host' },
        outcome: outcome === 'solved' ? 'succeeded' : 'failed',
        detail: StealthAuditDetailSchemas.captchaSolve.parse({
          identity: IDENTITY,
          siteHost: host,
          kind: widget.kind,
          vendor: this.ports.solver.vendor,
          outcome,
          ms: Math.max(0, Math.round(this.ports.nowMs() - started)),
          estimatedCostMicros: 'token' in result ? SOLVE_COST_MICROS[widget.kind] : 0,
        }),
      });
    if ('refused' in result && result.refused === 'cap') await this.sayCapOnce();
  }

  private async sayCapOnce(): Promise<void> {
    const month = new Date(this.ports.nowMs()).toISOString().slice(0, 7);
    if (this.capSaid === month) return;
    this.capSaid = month;
    await this.record(this.capReached());
  }

  private capReached(): AuditDraft {
    return {
      event: AUDIT.captchaCapReached,
      actor: { kind: 'host' },
      outcome: 'failed',
      detail: StealthAuditDetailSchemas.captchaCapReached.parse({
        vendor: this.ports.solver.vendor,
        capMicros: CAPTCHA_MONTHLY_CAP_MICROS,
      }),
    };
  }

  private async record(draft: AuditDraft): Promise<void> {
    await this.ports.audit(draft).catch(() => this.ports.failed('a captcha audit record was not written'));
  }
}

// ─── what a ferret is told ───────────────────────────────────────────────────────────────────────────────────

/** What an agent is told when its page appears to be asking for a human check and nothing here can answer it: the owner does. */
export const HUMAN_CHECK_NOTE =
  ' The page appears to be showing a human check (a captcha or a "checking your browser" page). Do not try to solve or get around it: ask your owner to take the page over in Ferretry and solve it themselves, then carry on.';

/** What an agent is told while the daemon solves the check for the owner (stealth in effect, a solver set up). */
export const SOLVING_NOTE =
  ' The page is showing a human check (a captcha). The browser is solving this check now: wait a few seconds and read the page again. If it still shows the check, ask your owner to take the page over in Ferretry and solve it themselves.';

/** What an agent is told for a page the daemon has already solved: nothing new is started, and the takeover is the way out if it still refuses. */
const SOLVED_NOTE =
  ' The page showed a human check (a captcha) and the browser has already solved it: carry on (submit the form or read the page again). If the page still refuses, ask your owner to take the page over in Ferretry and solve it themselves.';

/** What the tools service asks: start solving for this page, if it may. */
export interface CheckSolver {
  begin(sessionId: string, pageId: string): Promise<CaptchaStart>;
}

/**
 * A tool answer that carries the human-check note, for a ferret whose page the daemon may solve (stealth in effect): the
 * note becomes "wait, it is being solved", or says plainly why nothing is solving it and keeps the takeover. Every other
 * answer — a person's call, a page with no check, stealth off, no solver — is returned as it was.
 */
export async function solveCheck<Answer extends { readonly summary: string }>(
  solver: CheckSolver | undefined,
  caller: { readonly kind: string; readonly sessionId: string },
  surface: { readonly surface: string; readonly id: string } | undefined,
  answer: Answer,
): Promise<Answer> {
  if (solver === undefined || caller.kind !== 'agent' || surface?.surface !== 'browser') return answer;
  if (!answer.summary.includes(HUMAN_CHECK_NOTE)) return answer;
  const start = await solver.begin(caller.sessionId, surface.id).catch((): CaptchaStart => ({ kind: 'off' }));
  if (start.kind === 'off') return answer;
  const note =
    start.kind === 'solving'
      ? SOLVING_NOTE
      : start.kind === 'solved'
        ? SOLVED_NOTE
        : `${HUMAN_CHECK_NOTE} Automatic solving is not running: ${start.reason}`;
  return { ...answer, summary: answer.summary.replace(HUMAN_CHECK_NOTE, () => note) };
}

/**
 * The browser's own proxy as the solver is given it, so a token is issued to the address the page is seen from. Only a
 * proxy with no credentials is passed: the Vault hands Browsers none to read (GAP), so one with a `${secret:…}` login
 * is solved proxyless rather than sent half its address.
 */
export function captchaProxyOf(
  setting: { readonly url: string; readonly username?: string } | undefined,
): CaptchaProxy | undefined {
  if (setting === undefined || setting.username !== undefined) return undefined;
  try {
    const url = new URL(setting.url);
    const type = url.protocol.slice(0, -1);
    const port = Number(url.port);
    return (type === 'http' || type === 'https' || type === 'socks5') && url.hostname !== '' && port > 0
      ? { type, host: url.hostname, port }
      : undefined;
  } catch {
    return undefined;
  }
}
