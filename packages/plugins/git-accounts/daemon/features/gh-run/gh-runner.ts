/**
 * Ferretry's `gh` (r9 B9): which account, which repository, then `GitAccountsApi.run`.
 *
 * Use, never read. This class never holds a token: it names an account id and an argv to the seam, and the seam puts
 * the token in that one child's environment, in an empty private folder, and masks what comes back (B1, `service.run`).
 * The seam bounds each stream (4 MiB, read through the kernel's capped reader, then masked), so there is nothing to
 * cut again here. What this adds on top of the seam:
 * - the account comes from the folder (B4's one resolver) and, for a ferret, only from the ferret's OWN folder, so a
 *   ferret cannot claim a neighbouring project's account by naming its path;
 * - the repository comes from the project's record (B5's `repos[].remote`: text the scan wrote, not a file an agent can
 *   edit now), never from a file this daemon opens in an agent's folder, so a repository's own git config can never be
 *   read by, or run with, the token;
 * - the policy (`gh-policy.ts`) says why a refused command is refused and what to do instead;
 * - one audit record per call: the account id, the command (two plain words), the repository and the exit code. No other
 *   argument, no body.
 */
import { ApiError } from '@ferretry/kernel/contract';
import type { AuditActor, AuditDraft } from '@ferretry/core-gate/contract';
import { auditKind } from '@ferretry/core-gate/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import {
  GIT_ACCOUNT_AUDIT,
  GIT_ACCOUNT_CODES,
  type GhRunAnswer,
  type GhRunRequest,
  type GitAccount,
  type GitAccountsApi,
} from '../../../contract/index.ts';
import { accountForFolder } from '../../lib/account-for-folder.ts';
import { fillPlaceholders, isFollowing, judgeGh, namesRepository, withRepository } from './gh-policy.ts';

const PLAIN_RUN_MS = 120_000;
/** The seam clamps a run to 5 minutes; a followed workflow gets all of it. */
const FOLLOW_RUN_MS = 300_000;
const MAX_RUNS_PER_CALLER = 4;
/** The longest refusal a `GhRunAnswer` carries (`GhRunAnswerSchema`). */
const MAX_REFUSAL_LENGTH = 1_000;

const NO_PROJECT =
  "This folder is in no project linked to a GitHub account, so Ferretry's gh has no account here. Link one on the project page.";
const NO_REPOSITORY =
  "Ferretry's gh does not know which repository this folder is. Name it with -R OWNER/NAME, or open the project page so Ferretry scans its repositories.";
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u;

/** Who is calling: a ferret (with the one folder it may work in) or a person. */
export interface GhCaller {
  readonly actor: AuditActor;
  /** The calling ferret's id, when it is one. */
  readonly ferret?: string;
}

export interface GhRunnerDeps {
  readonly accounts: Pick<GitAccountsApi, 'list' | 'run'>;
  /** The registered projects; empty when Projects is not there. */
  readonly projects: () => Promise<readonly ProjectInfo[]>;
  /** A ferret's own work folder (real path, as Ferrets resolves it); `undefined` when it cannot be placed. */
  readonly workFolder: (ferret: string) => Promise<string | undefined>;
  readonly audit: (draft: AuditDraft) => Promise<void>;
}

const plain = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);
const inside = (root: string, folder: string): boolean =>
  root === '/' || folder === root || folder.startsWith(`${root}/`);
const clean = (path: string): boolean => !path.split('/').some(part => part === '..' || part === '.');

export class GhRunner {
  readonly #running = new Map<string, number>();

  constructor(private readonly deps: GhRunnerDeps) {}

  async run(caller: GhCaller, request: GhRunRequest): Promise<GhRunAnswer> {
    const verdict = judgeGh(request.argv);
    if (verdict.kind === 'refuse') {
      await this.#record(caller, 'refused', { command: verdict.command });
      return { refused: verdict.sentence };
    }
    const refused = async (sentence: string, detail: Record<string, string | number>): Promise<GhRunAnswer> => {
      await this.#record(caller, 'refused', { command: verdict.command, ...detail });
      return { refused: sentence };
    };

    if (caller.ferret !== undefined && request.account !== undefined)
      return refused('A ferret does not choose the account: Ferretry uses the one linked to its project.', {});
    const cwd = plain(request.cwd);
    if (!clean(cwd)) return refused('The folder must be a plain absolute path.', {});
    const own = caller.ferret === undefined ? undefined : await this.deps.workFolder(caller.ferret);
    if (caller.ferret !== undefined && (own === undefined || !inside(plain(own), cwd)))
      return refused("Ferretry's gh runs only for the folder this ferret works in.", {});

    const accounts = await this.deps.accounts.list();
    const projects = await this.deps.projects();
    const exists = (id: string) => accounts.some(account => account.id === id);
    const found = accountForFolder(cwd, projects, exists);
    if (own !== undefined) {
      // A ferret is handed the account of its OWN folder (B4's launch); a project nested below it must not lend it another.
      const mine = accountForFolder(plain(own), projects, exists);
      if (mine?.project !== found?.project || mine?.account !== found?.account)
        return refused("Ferretry's gh runs only for the folder this ferret works in.", {});
    }
    const chosen = request.account === undefined ? undefined : pick(accounts, request.account);
    if (request.account !== undefined && chosen === undefined)
      return refused('No connected GitHub account has that login or id.', {});
    const account = chosen ?? accounts.find(each => each.id === found?.account);
    if (account === undefined) return refused(NO_PROJECT, {});

    if (verdict.kind === 'auth-status') {
      await this.#record(caller, 'succeeded', { command: verdict.command, account: account.id, exitCode: 0 });
      return { exitCode: 0, stdout: signedInAs(account), stderr: '' };
    }

    const repo = repoOf(found?.repo?.remote);
    let argv = verdict.argv;
    if (repo !== undefined && argv[0] === 'api') argv = fillPlaceholders(argv, repo);
    if (verdict.repoCommand && !namesRepository(argv)) {
      if (repo === undefined) return refused(NO_REPOSITORY, { account: account.id });
      argv = withRepository(argv, repo);
    }

    const key =
      caller.ferret !== undefined
        ? `ferret:${caller.ferret}`
        : caller.actor.kind === 'device' && caller.actor.deviceId !== undefined
          ? `device:${caller.actor.deviceId}`
          : 'person';
    if ((this.#running.get(key) ?? 0) >= MAX_RUNS_PER_CALLER)
      return refused("Ferretry's gh is already running 4 commands for you: wait for one to finish.", {
        account: account.id,
      });
    this.#running.set(key, (this.#running.get(key) ?? 0) + 1);
    try {
      const result = await this.deps.accounts.run(account.id, {
        program: 'gh',
        args: argv,
        timeoutMs: isFollowing(argv) ? FOLLOW_RUN_MS : PLAIN_RUN_MS,
      });
      await this.#record(caller, result.exitCode === 0 ? 'succeeded' : 'failed', {
        command: verdict.command,
        account: account.id,
        ...(repo === undefined ? {} : { repo }),
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      // The seam under this one is narrower than this policy and says so in a sentence: pass that sentence on, cut to
      // what an answer may carry (a long unknown flag makes a long sentence, and an over-long one would be a 500).
      if (error instanceof ApiError && error.code === GIT_ACCOUNT_CODES.invalidRequest && error.status === 403)
        return refused(error.message.slice(0, MAX_REFUSAL_LENGTH), { account: account.id });
      // Any other failure is still a call somebody made as that account: one record (no argument, body or folder), then the error.
      await this.#record(caller, 'failed', {
        command: verdict.command,
        account: account.id,
        ...(repo === undefined ? {} : { repo }),
      });
      throw error;
    } finally {
      const left = (this.#running.get(key) ?? 1) - 1;
      if (left <= 0) this.#running.delete(key);
      else this.#running.set(key, left);
    }
  }

  async #record(
    caller: GhCaller,
    outcome: 'succeeded' | 'refused' | 'failed',
    detail: { command: string; account?: string; repo?: string; exitCode?: number },
  ): Promise<void> {
    const { account, ...rest } = detail;
    await this.deps
      .audit({
        event: auditKind(GIT_ACCOUNT_AUDIT.ghRun),
        actor: caller.actor,
        ...(account === undefined ? {} : { subject: account }),
        outcome,
        detail: { ...rest, ...(caller.ferret === undefined ? {} : { ferret: caller.ferret.slice(0, 160) }) },
      })
      .catch(() => undefined);
  }
}

const pick = (accounts: readonly GitAccount[], wanted: string): GitAccount | undefined =>
  accounts.find(account => account.id === wanted || account.login.toLowerCase() === wanted.toLowerCase());

/** `owner/name` from a project's recorded remote, only when it is a github.com repository. */
function repoOf(remote: string | undefined): string | undefined {
  const match = remote === undefined ? null : GITHUB_REPO.exec(remote);
  return match === null || match === undefined ? undefined : `${match[1] as string}/${match[2] as string}`;
}

const signedInAs = (account: GitAccount): string =>
  `github.com\n  ✓ Logged in to github.com as ${account.login} (Ferretry)\n  - Token scopes: ${account.scopes.join(', ') || 'none'}\n`;
