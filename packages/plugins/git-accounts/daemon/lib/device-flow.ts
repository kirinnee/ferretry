/**
 * GitHub's OAuth device flow, daemon side. No client secret exists: `client_id` + `device_code` is the whole proof.
 *
 * The `device_code` is a bearer for the token (whoever polls it after the person authorizes receives the token), so
 * it lives only in this map, and only while the flow can still use it: it is dropped the moment the flow is done,
 * denied or expired (a timer at the expiry, and a check on every read). The page gets OUR flow id and the short user
 * code. A poll faster than the interval is
 * answered `pending` without asking GitHub, and a `slow_down` adds five seconds, as GitHub's rules say.
 */
import { randomBytes } from 'node:crypto';
import { ApiError } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  GIT_ACCOUNT_CODES,
  GITHUB_SCOPES,
  type GitAccountId,
  type GitDeviceFlow,
  type GitDeviceFlowStatus,
} from '../../contract/index.ts';
import type { GithubHttp } from './github-http.ts';
import type { AccountBook } from './accounts.ts';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const VERIFICATION_HOST = 'github.com';
const SLOW_DOWN_SECONDS = 5;
const MAX_LIVE_FLOWS = 8;
const DONE_KEPT_MS = 10 * 60_000;
const MAX_INTERVAL = 600;

const DeviceCodeAnswer = z.object({
  device_code: z.string().min(1).max(512),
  user_code: z.string().min(1).max(32),
  verification_uri: z.string().min(1).max(300),
  expires_in: z.number().int().min(30).max(3600),
  interval: z.number().int().min(1).max(MAX_INTERVAL).default(5),
});
const TokenAnswer = z.object({
  access_token: z.string().min(1).max(1024).optional(),
  scope: z.string().max(500).optional(),
  error: z.string().max(100).optional(),
  interval: z.number().int().min(1).max(MAX_INTERVAL).optional(),
});
const UserAnswer = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1).max(100),
  name: z.string().max(200).nullish(),
  avatar_url: z.url().max(500).nullish(),
});

type Final = Extract<GitDeviceFlowStatus, { status: 'done' | 'expired' | 'denied' }>;

interface Flow {
  /** Gone (`undefined`) as soon as the flow is terminal or past its expiry. */
  deviceCode: string | undefined;
  readonly expiresAtMs: number;
  interval: number;
  nextPollMs: number;
  final?: Final;
  finalAtMs?: number;
  polling?: Promise<GitDeviceFlowStatus>;
  /** The account this flow filed, until the route has taken it to record it (once). */
  connected?: GitAccountId;
  cancelExpiry?: () => void;
}

export interface DeviceFlowDeps {
  readonly http: GithubHttp;
  readonly book: AccountBook;
  readonly clientId: () => string;
  readonly nowMs: () => number;
  readonly newId?: () => string;
  /** Runs `fn` after `ms`; returns how to cancel (the kernel clock's `after`). */
  readonly after: (ms: number, fn: () => void) => () => void;
}

export class GithubDeviceFlows {
  readonly #flows = new Map<string, Flow>();
  constructor(private readonly deps: DeviceFlowDeps) {}

  async start(): Promise<GitDeviceFlow> {
    const clientId = this.deps.clientId();
    if (clientId === '')
      throw new ApiError(
        409,
        'no GitHub OAuth app is set: put its client id in config/git-accounts.yaml (github.clientId)',
        GIT_ACCOUNT_CODES.clientIdUnset,
      );
    this.#prune();
    if (this.#flows.size >= MAX_LIVE_FLOWS)
      throw new ApiError(
        429,
        'too many GitHub sign-ins are open; finish or wait for one',
        GIT_ACCOUNT_CODES.tooManyFlows,
      );
    const response = await this.deps.http.request({
      method: 'POST',
      url: DEVICE_CODE_URL,
      form: { client_id: clientId, scope: GITHUB_SCOPES.join(' ') },
    });
    const parsed = DeviceCodeAnswer.safeParse(response.body);
    if (response.status !== 200 || !parsed.success)
      throw new ApiError(502, 'GitHub did not start a device sign-in', GIT_ACCOUNT_CODES.providerRefused);
    const verification = new URL(parsed.data.verification_uri);
    if (verification.protocol !== 'https:' || verification.host !== VERIFICATION_HOST)
      throw new ApiError(502, 'GitHub named an unexpected verification address', GIT_ACCOUNT_CODES.providerRefused);
    const now = this.deps.nowMs();
    const flowId = (this.deps.newId ?? (() => randomBytes(18).toString('base64url')))();
    const expiresAtMs = now + parsed.data.expires_in * 1000;
    const flow: Flow = {
      deviceCode: parsed.data.device_code,
      expiresAtMs,
      interval: parsed.data.interval,
      nextPollMs: now + parsed.data.interval * 1000,
    };
    flow.cancelExpiry = this.deps.after(parsed.data.expires_in * 1000, () => {
      if (flow.final === undefined && flow.polling === undefined) this.#settle(flow, { status: 'expired' });
    });
    this.#flows.set(flowId, flow);
    return {
      flowId,
      provider: 'github',
      userCode: parsed.data.user_code,
      verificationUri: verification.toString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      interval: parsed.data.interval,
    };
  }

  async poll(flowId: string): Promise<GitDeviceFlowStatus> {
    const flow = this.#flows.get(flowId);
    if (flow === undefined) throw new ApiError(404, 'no such sign-in is open', GIT_ACCOUNT_CODES.unknownFlow);
    if (flow.final !== undefined) return flow.final;
    const now = this.deps.nowMs();
    if (now >= flow.expiresAtMs) return this.#settle(flow, { status: 'expired' });
    if (now < flow.nextPollMs) return { status: 'pending', interval: flow.interval };
    flow.polling ??= this.#ask(flow).finally(() => {
      flow.polling = undefined;
    });
    return await flow.polling;
  }

  /** The account a finished flow filed, once: the first caller gets it, so the connect is recorded once. */
  takeConnected(flowId: string): GitAccountId | undefined {
    const flow = this.#flows.get(flowId);
    const id = flow?.connected;
    if (flow !== undefined) delete flow.connected;
    return id;
  }

  /** How many flows still hold a device code (a count, for a test and the doctor; never a code). */
  liveDeviceCodes(): number {
    return [...this.#flows.values()].filter(flow => flow.deviceCode !== undefined).length;
  }

  #settle(flow: Flow, final: Final): Final {
    flow.deviceCode = undefined;
    flow.cancelExpiry?.();
    flow.cancelExpiry = undefined;
    flow.final = final;
    flow.finalAtMs = this.deps.nowMs();
    return final;
  }

  async #ask(flow: Flow): Promise<GitDeviceFlowStatus> {
    if (flow.deviceCode === undefined) return this.#settle(flow, { status: 'expired' });
    const response = await this.deps.http.request({
      method: 'POST',
      url: ACCESS_TOKEN_URL,
      form: {
        client_id: this.deps.clientId(),
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
    });
    const parsed = TokenAnswer.safeParse(response.body);
    if (!parsed.success)
      throw new ApiError(502, 'GitHub answered a sign-in poll unexpectedly', GIT_ACCOUNT_CODES.providerRefused);
    const answer = parsed.data;
    if (answer.access_token !== undefined) return await this.#finish(flow, answer.access_token, answer.scope);
    switch (answer.error) {
      case 'authorization_pending':
        flow.nextPollMs = this.deps.nowMs() + flow.interval * 1000;
        return { status: 'pending', interval: flow.interval };
      case 'slow_down':
        flow.interval = Math.min(MAX_INTERVAL, answer.interval ?? flow.interval + SLOW_DOWN_SECONDS);
        flow.nextPollMs = this.deps.nowMs() + flow.interval * 1000;
        return { status: 'slow_down', interval: flow.interval };
      case 'expired_token':
        return this.#settle(flow, { status: 'expired' });
      case 'access_denied':
        return this.#settle(flow, { status: 'denied' });
      default:
        throw new ApiError(502, 'GitHub refused the sign-in', GIT_ACCOUNT_CODES.providerRefused);
    }
  }

  async #finish(flow: Flow, token: string, scope: string | undefined): Promise<GitDeviceFlowStatus> {
    const who = await this.deps.http.request({ method: 'GET', url: USER_URL, bearer: token });
    const user = UserAnswer.safeParse(who.body);
    if (who.status !== 200 || !user.success)
      throw new ApiError(502, 'GitHub did not say who signed in; nothing was saved', GIT_ACCOUNT_CODES.providerRefused);
    const id = `gha_${String(user.data.id)}` as GitAccountId;
    const scopes = (scope ?? '')
      .split(/[,\s]+/u)
      .map(item => item.trim())
      .filter(item => item !== '');
    await this.deps.book.upsert(
      {
        id,
        githubId: user.data.id,
        login: user.data.login,
        ...(user.data.name ? { name: user.data.name } : {}),
        ...(user.data.avatar_url ? { avatarUrl: user.data.avatar_url } : {}),
        scopes,
      },
      token,
    );
    flow.connected = id;
    return this.#settle(flow, { status: 'done', accountId: id, login: user.data.login });
  }

  #prune(): void {
    const now = this.deps.nowMs();
    for (const [id, flow] of this.#flows) {
      const finished = flow.finalAtMs !== undefined && now - flow.finalAtMs > DONE_KEPT_MS;
      if (finished || now - flow.expiresAtMs > DONE_KEPT_MS) this.#flows.delete(id);
    }
  }
}
