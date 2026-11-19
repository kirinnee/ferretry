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
import type { ScratchPort, SpawnPort } from '@ferretry/kernel/contract';
import { checkGhArgs, scrubToken } from './gh-guard.ts';
import type { GithubHttp } from './github-http.ts';
import type { AccountBook } from './accounts.ts';

const MAX_BODY_BYTES = 256 * 1024;

export class GitAccountsService {
  constructor(
    private readonly book: AccountBook,
    private readonly http: GithubHttp,
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly scratch: ScratchPort,
    /** Tells the rest of the daemon an account is gone, once its token and record are. */
    private readonly removed: (id: GitAccountId) => unknown,
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
   * host's own variables ride along). What that child can be asked to do is narrowed three ways: the argv must pass the
   * allow-list (`checkGhArgs`); it runs in an empty private folder that is also its HOME and `GH_CONFIG_DIR` (no
   * host aliases, extensions or config); and nothing interactive can start (no prompt, pager, editor or browser). Both
   * streams come back with the token, and anything shaped like a GitHub token, masked.
   */
  async run(id: GitAccountId, spec: GitRunSpec): Promise<GitRunResult> {
    if (spec.program !== 'gh')
      throw new ApiError(403, 'only gh runs with an account', GIT_ACCOUNT_CODES.invalidRequest);
    checkGhArgs(spec.args);
    const token = await this.#tokenOf(id);
    const timeout = milliseconds(Math.min(Math.max(spec.timeoutMs ?? 60_000, 1_000), 300_000));
    const folder = await this.scratch.open();
    try {
      await folder.makeDirectory('home');
      await folder.makeDirectory('home/config');
      await folder.writeFile('refuse', '#!/bin/sh\nexit 1\n', 0o700);
      const home = `${folder.path}/home`;
      const refuse = `${folder.path}/refuse`;
      const env: Record<string, string> = {
        GH_TOKEN: token,
        GH_HOST: 'github.com',
        GH_CONFIG_DIR: `${home}/config`,
        HOME: home,
        XDG_CONFIG_HOME: `${home}/config`,
        XDG_DATA_HOME: `${home}/data`,
        XDG_STATE_HOME: `${home}/state`,
        XDG_CACHE_HOME: `${home}/cache`,
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        GH_EDITOR: refuse,
        GIT_EDITOR: refuse,
        EDITOR: refuse,
        VISUAL: refuse,
        GIT_ASKPASS: refuse,
        SSH_ASKPASS: refuse,
        BROWSER: refuse,
        GH_BROWSER: refuse,
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
        GH_SPINNER_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        NO_COLOR: '1',
      };
      const result = await this.spawn.run('gh', [...spec.args], { env, sealed: true, timeout, cwd: folder.path });
      return {
        exitCode: result.exitCode,
        stdout: scrubToken(result.stdout, token),
        stderr: scrubToken(result.stderr, token),
      };
    } finally {
      await folder.close().catch(() => undefined);
    }
  }

  /**
   * Deletes the keys this machine registered (through the API, with the account's own token), then the sealed token,
   * then the record. A key GitHub will not delete is named in the answer for the person to remove there; it does not
   * keep the account connected. Revoking the app's grant needs the client secret we deliberately do not have.
   */
  async remove(id: GitAccountId): Promise<GitAccountRemoved> {
    const account = await this.book.find(id);
    if (account === undefined) {
      // A token with no record (a connect whose record never landed) must still be removable, or it is stranded.
      if ((await this.book.token(id)) === undefined)
        throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
      await this.book.forget(id);
      await this.removed(id);
      return { id, removed: true, keysLeftOnProvider: [], revokeAt: GITHUB_REVOKE_URL };
    }
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
    await this.removed(id);
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
