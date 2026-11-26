/** Account facts and the API on an account's behalf: the path allow-list, and removal that deletes keys first. */
import { ApiError } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  GIT_ACCOUNT_CODES,
  GITHUB_API_QUERY,
  GITHUB_API_RULES,
  GITHUB_REVOKE_URL,
  MAX_GH_OUTPUT_BYTES,
  type GitAccount,
  type GitAccountId,
  type GitAccountKeys,
  type GitAccountRemoved,
  type GitApiAnswer,
  type GitApiCall,
  type GitRunResult,
  type GitRunSpec,
  isGpgKey,
} from '../../contract/index.ts';
import type { ScratchPort, SpawnPort } from '@ferretry/kernel/contract';
import { checkGhArgs, scrubCut, scrubToken } from './gh-guard.ts';
import type { GithubHttp } from './github-http.ts';
import type { AccountBook } from './accounts.ts';
import type { GhLaunch } from './gh-locator.ts';

const MAX_BODY_BYTES = 256 * 1024;

export class GitAccountsService {
  constructor(
    private readonly book: AccountBook,
    private readonly http: GithubHttp,
    private readonly spawn: Pick<SpawnPort, 'runBytes'>,
    private readonly scratch: ScratchPort,
    /** Tells the rest of the daemon an account is gone, once its token and record are. */
    private readonly removed: (id: GitAccountId) => unknown,
    /** Runs once an account is on its way out, after its keys are off GitHub and before its token goes (B3: stops its agent, drops its private key). */
    private readonly beforeForget: (id: GitAccountId) => Promise<void>,
    /** The `gh` to run with a token and the `PATH` it runs with: an absolute path and folders outside the state home (`gh-locator.ts`), or a refusal. */
    private readonly ghProgram: () => Promise<GhLaunch>,
    private readonly exclusive: <T>(id: GitAccountId, work: () => Promise<T>) => Promise<T>,
  ) {}

  list(): Promise<readonly GitAccount[]> {
    return this.book.list();
  }

  find(id: GitAccountId): Promise<GitAccount | undefined> {
    return this.book.find(id);
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
   * streams come back with the token, and anything shaped like a GitHub token, masked, and each is read only up to
   * `MAX_GH_OUTPUT_BYTES` (a reader that stops there, so a huge log never sits in this daemon's memory): a stream that
   * was cut ends with `[output cut]` and loses any tail that could be the start of a token.
   */
  async run(id: GitAccountId, spec: GitRunSpec): Promise<GitRunResult> {
    if (spec.program !== 'gh')
      throw new ApiError(403, 'only gh runs with an account', GIT_ACCOUNT_CODES.invalidRequest);
    checkGhArgs(spec.args);
    // Which program runs is settled BEFORE the token is read: a `gh` that cannot be trusted never sees one.
    const { program, path } = await this.ghProgram();
    const token = await this.#tokenOf(id);
    const timeout = milliseconds(Math.min(Math.max(spec.timeoutMs ?? 60_000, 1_000), 300_000));
    const folder = await this.scratch.open();
    try {
      // `GIT_CEILING_DIRECTORIES` is a colon-separated list and has no way to escape a `:`: a scratch parent holding one
      // would be cut in two and the fence lost. Refuse BEFORE a child that holds the token is started.
      const ceiling = folder.path.slice(0, folder.path.lastIndexOf('/')) || '/';
      if (ceiling.includes(':'))
        throw new ApiError(
          503,
          "gh cannot run here: the daemon's scratch folder is under a path with a ':' in it; set TMPDIR to one without",
          GIT_ACCOUNT_CODES.scratchUnusable,
        );
      await folder.makeDirectory('home');
      await folder.makeDirectory('home/config');
      await folder.writeFile('refuse', '#!/bin/sh\nexit 1\n', 0o700);
      const home = `${folder.path}/home`;
      const refuse = `${folder.path}/refuse`;
      const env: Record<string, string> = {
        // Not the daemon's own `PATH` (a sealed child would inherit it, shim folder and all): the locator's filtered one.
        PATH: path,
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
        // `git` (a `pr merge --delete-branch` may start one) looks upward for a repository: stop at this scratch
        // folder, so a `.git` in a parent folder is never found.
        GIT_CEILING_DIRECTORIES: ceiling,
        NO_COLOR: '1',
      };
      const result = await this.spawn.runBytes(program, [...spec.args], {
        env,
        sealed: true,
        timeout,
        cwd: folder.path,
        maxStdoutBytes: MAX_GH_OUTPUT_BYTES,
        maxStderrBytes: MAX_GH_OUTPUT_BYTES,
      });
      const scrub = (text: string, cut: boolean) => (cut ? scrubCut(text, token) : scrubToken(text, token));
      return {
        // `runBytes` answers -1 for a child it had to kill (or one a signal ended): no exit code of its own.
        exitCode: result.exitCode < 0 ? null : result.exitCode,
        stdout: scrub(new TextDecoder().decode(result.stdout), result.stdoutTruncated),
        stderr: scrub(result.stderr, result.stderrTruncated),
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
  remove(id: GitAccountId): Promise<GitAccountRemoved> {
    return this.exclusive(id, () => this.#removeLocked(id));
  }

  async #removeLocked(id: GitAccountId): Promise<GitAccountRemoved> {
    // Storage reads can fail too: first close every local capability, independently of metadata/token availability.
    await this.beforeForget(id);
    const account = await this.book.find(id);
    if (account === undefined) {
      // A token with no record (a connect whose record never landed) must still be removable, or it is stranded.
      if ((await this.book.token(id)) === undefined)
        throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
      await this.book.forget(id);
      await this.removed(id);
      return { id, removed: true, keysLeftOnProvider: [], gpgUploadsToCheck: [], revokeAt: GITHUB_REVOKE_URL };
    }
    const left: string[] = [];
    const gpgUploadsToCheck: string[] = [];
    const registered = [
      { key: account.keys.ssh, base: '/user/keys' },
      { key: account.keys.signing, base: isGpgKey(account.keys.signing) ? '/user/gpg_keys' : '/user/ssh_signing_keys' },
    ];
    // Stop local signing before remote I/O. The lock keeps the snapshot and the capability consistent with creates.
    const token = await this.book.token(id);
    for (const { key, base } of registered) {
      // A key the person already had (`source: own`) was never ours to delete.
      if (key === undefined || key.source === 'own') continue;
      if (key.githubKeyId === undefined) {
        if (key.registrationPending === true && key.openpgpFingerprint !== undefined)
          gpgUploadsToCheck.push(key.openpgpFingerprint);
        continue;
      }
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
    return { id, removed: true, keysLeftOnProvider: left, gpgUploadsToCheck, revokeAt: GITHUB_REVOKE_URL };
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
