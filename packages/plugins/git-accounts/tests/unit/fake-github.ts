/** A scripted GitHub for the device flow: answers what `github.com` and `api.github.com` would, and records every call. */
export const FAKE_TOKEN = 'gho_FAKE_TOKEN_0123456789abcdefABCDEF';
export const FAKE_DEVICE_CODE = 'dev-code-FAKE-0123456789abcdef';
export const FAKE_USER_CODE = 'WDJB-MJHT';

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string;
  readonly body: string;
}

export class FakeGithub {
  readonly seen: Seen[] = [];
  /** What the next token polls answer, in order; the last one repeats. */
  tokenAnswers: Array<Record<string, unknown>> = [{ error: 'authorization_pending' }];
  user: Record<string, unknown> = {
    id: 4242,
    login: 'octo-fake',
    name: 'Octo Fake',
    avatar_url: 'https://avatars.example/u/4242',
  };
  userStatus = 200;
  deviceInterval = 5;
  deviceExpiresIn = 900;
  verificationUri = 'https://github.com/login/device';
  /** Statuses answered to DELETE of a key, by path. Default 204. */
  deleteStatus = new Map<string, number>();
  #polls = 0;

  readonly fetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    this.seen.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      ...(headers.get('authorization') === null ? {} : { authorization: headers.get('authorization') as string }),
      body,
    });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          'content-type': 'application/json',
          'x-oauth-scopes': 'read:user, user:email',
          etag: 'W/"abc123"',
          link: '<https://api.github.com/x?page=2>; rel="next"',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': '1790000000',
          'set-cookie': 'session=SHOULD-NEVER-PASS',
        },
      });
    if (
      url.host === 'api.github.com' &&
      headers.get('if-none-match') === 'W/"abc123"' &&
      init?.method === 'GET' &&
      url.pathname !== '/user'
    )
      return new Response(null, { status: 304, headers: { etag: 'W/"abc123"', 'x-ratelimit-remaining': '4998' } });
    if (url.host === 'github.com' && url.pathname === '/login/device/code')
      return json({
        device_code: FAKE_DEVICE_CODE,
        user_code: FAKE_USER_CODE,
        verification_uri: this.verificationUri,
        expires_in: this.deviceExpiresIn,
        interval: this.deviceInterval,
      });
    if (url.host === 'github.com' && url.pathname === '/login/oauth/access_token') {
      const answer = this.tokenAnswers[Math.min(this.#polls, this.tokenAnswers.length - 1)] as Record<string, unknown>;
      this.#polls += 1;
      return json(answer);
    }
    if (url.host === 'api.github.com' && url.pathname === '/user' && init?.method !== 'DELETE')
      return json(this.user, this.userStatus);
    if (url.host === 'api.github.com' && init?.method === 'DELETE')
      return new Response(null, { status: this.deleteStatus.get(url.pathname) ?? 204 });
    if (url.host === 'api.github.com') return json({ ok: true, path: url.pathname });
    return new Response('not found', { status: 404 });
  };

  get tokenPolls(): number {
    return this.#polls;
  }
  calls(host: string, path: string): Seen[] {
    return this.seen.filter(call => new URL(call.url).host === host && new URL(call.url).pathname === path);
  }
}
