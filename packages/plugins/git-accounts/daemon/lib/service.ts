/** Account facts and the API on an account's behalf: the path allow-list, and removal that deletes keys first. */
import { ApiError } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  GIT_ACCOUNT_CODES,
  GITHUB_API_QUERY,
  GITHUB_API_RULES,
  GITHUB_REVOKE_URL,
  type GitAccount,
  type GitAccountId,
  type GitAccountKeys,
  type GitAccountRemoved,
  type GitApiAnswer,
  type GitApiCall,
  type GitRunResult,
  type GitRunSpec,
} from '../../contract/index.ts';
import type { SpawnPort } from '@ferretry/kernel/contract';
import type { GithubHttp } from './github-http.ts';
import type { AccountBook } from './accounts.ts';

const MAX_BODY_BYTES = 256 * 1024;

export class GitAccountsService {
  constructor(
    private readonly book: AccountBook,
    private readonly http: GithubHttp,
    private readonly spawn: Pick<SpawnPort, 'run'>,
  ) {}

  list(): Promise<readonly GitAccount[]> {
    return this.book.list();
  }

  recordKeys(id: GitAccountId, keys: GitAccountKeys): Promise<void> {
    return this.book.recordKeys(id, keys);
  }

  async api(id: GitAccountId, call: GitApiCall): Promise<GitApiAnswer> {
    const at = call.path.search(/[?#]/u);
    const path = at < 0 ? call.path : call.path.slice(0, at);
    const query = at < 0 ? '' : call.path.slice(at);
    const rules: readonly RegExp[] = GITHUB_API_RULES[call.method] ?? [];
    const plain = !path.includes('..') && !path.includes('//');
    if (!plain || !rules.some(pattern => pattern.test(path)) || (query !== '' && !GITHUB_API_QUERY.test(query)))
      throw new ApiError(403, 'that GitHub API call is not one Git accounts makes', GIT_ACCOUNT_CODES.invalidRequest);
    if (call.body !== undefined && JSON.stringify(call.body).length > MAX_BODY_BYTES)
      throw new ApiError(413, 'that request body is too large', GIT_ACCOUNT_CODES.invalidRequest);
    const token = await this.#tokenOf(id);
    const response = await this.http.request({
      method: call.method,
      url: `https://api.github.com${path}${query}`,
      bearer: token,
      ...(call.ifNoneMatch === undefined ? {} : { ifNoneMatch: call.ifNoneMatch }),
      ...(call.body === undefined ? {} : { json: call.body }),
    });
    return { status: response.status, body: response.body, headers: response.headers };
  }

  /**
   * `gh` as the account. The token goes into that one child's environment and nowhere else (`sealed`: none of the
   * host's own variables ride along); both streams come back with the token masked, whatever the child printed.
   */
  async run(id: GitAccountId, spec: GitRunSpec): Promise<GitRunResult> {
    if (spec.program !== 'gh')
      throw new ApiError(403, 'only gh runs with an account', GIT_ACCOUNT_CODES.invalidRequest);
    const token = await this.#tokenOf(id);
    const timeout = milliseconds(Math.min(Math.max(spec.timeoutMs ?? 60_000, 1_000), 300_000));
    const result = await this.spawn.run('gh', [...spec.args], { env: { GH_TOKEN: token }, sealed: true, timeout });
    const mask = (text: string): string => text.split(token).join('[redacted]');
    return { exitCode: result.exitCode, stdout: mask(result.stdout), stderr: mask(result.stderr) };
  }

  /**
   * Deletes the keys this machine registered (through the API, with the account's own token), then the sealed token,
   * then the record. A key GitHub will not delete is named in the answer for the person to remove there; it does not
   * keep the account connected. Revoking the app's grant needs the client secret we deliberately do not have.
   */
  async remove(id: GitAccountId): Promise<GitAccountRemoved> {
    const account = await this.book.find(id);
    if (account === undefined) throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
    const left: string[] = [];
    const token = await this.book.token(id);
    const registered = [
      { key: account.keys.ssh, base: '/user/keys' },
      { key: account.keys.signing, base: '/user/ssh_signing_keys' },
    ];
    for (const { key, base } of registered) {
      if (key === undefined) continue;
      if (token === undefined) {
        left.push(key.title);
        continue;
      }
      try {
        const answer = await this.http.request({
          method: 'DELETE',
          url: `https://api.github.com${base}/${key.githubKeyId}`,
          bearer: token,
        });
        if (answer.status !== 204 && answer.status !== 404) left.push(key.title);
      } catch {
        left.push(key.title);
      }
    }
    await this.book.forget(id);
    return { id, removed: true, keysLeftOnProvider: left, revokeAt: GITHUB_REVOKE_URL };
  }

  async #tokenOf(id: GitAccountId): Promise<string> {
    if ((await this.book.find(id)) === undefined)
      throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
    const token = await this.book.token(id);
    if (token === undefined)
      throw new ApiError(
        409,
        'this Git account has no token on this machine; connect it again',
        GIT_ACCOUNT_CODES.unknownAccount,
      );
    return token;
  }
}
