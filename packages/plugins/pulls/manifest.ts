import { definePlugin, route, screen } from '@ferretry/kernel/manifest';
import { GitAccountDisconnected, GitAccountsPort } from '@ferretry/plugin-git-accounts/contract';
import { ProjectsPort, ProjectRemoved } from '@ferretry/plugin-projects/contract';
import { AccessPort } from './contract/others.ts';
import { audit, GatePort } from '@ferretry/core-gate/contract';
import {
  PULLS_AUDIT,
  PULLS_AUDIT_SKIP,
  PULLS_CACHE,
  PULLS_CAPS,
  PULLS_GUARD,
  PULLS_GUARD_POST,
  PULLS_WORDS,
  PullsChanged,
  PullsPort,
  PullsConfigDef,
  WATCH_STATE,
} from './contract/index.ts';

/**
 * PRs & CI (r9 track E): a project's pull requests and CI, inside Ferretry. E1 is the base the other units stand on: the
 * contract, a GitHub client over `git-accounts`' api seam (ETag reads, `Link` paging, a rate budget) and the per-project
 * cache. E1 filed no route; each later unit adds its own route declaration here and one registration line to `daemon/routes.ts`. E8 files the CI reads; E4 files the PR page (route and screen).
 *
 * NO TOKEN. This plugin names an account by id and `git-accounts` places the token on the request; nothing here can
 * read one. It needs no network permission of its own for the same reason: it never makes the request.
 */
/** E7: the one shape of a post route. */
const POST_ROUTE = {
  minimum: 'operator',
  caller: 'person',
  capability: PULLS_CAPS.post,
  noStore: true,
  audit: PULLS_AUDIT_SKIP.post,
  guard: PULLS_GUARD_POST,
} as const;

export default definePlugin({
  id: 'pulls',
  title: 'PRs & CI',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: PULLS_WORDS,

  needs: { gitAccounts: GitAccountsPort, projects: ProjectsPort },
  // E2 buzzes the phone through Access when it is there; without it the watch still keeps and shows PRs.
  // E7 records every post through Gate's audit door; with no Gate no post is made.
  uses: { access: AccessPort, gate: GatePort },
  // G3 U5: the latest PR of each branch, for the worktree cleanup.
  provides: { pulls: PullsPort },

  actions: {
    routes: [
      route('GET /v1/pulls/watch', {
        minimum: 'operator',
        caller: 'any',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: PULLS_AUDIT_SKIP.read,
        guard: PULLS_GUARD,
      }),
      route('PATCH /v1/pulls/watch/:project', {
        minimum: 'operator',
        caller: 'person',
        capability: PULLS_CAPS.configure,
        noStore: true,
        audit: audit(PULLS_AUDIT.watchChanged),
        guard: PULLS_GUARD,
      }),
      // E8 (CI data): a person's read of a project repository's CI. Names, statuses and times; logs are never read.
      route('GET /v1/pulls/:project/:repo/runs', {
        minimum: 'operator',
        caller: 'person',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: { skip: 'a read of CI run names, statuses and times for a project repository' },
        guard: { none: 'run, job and step names, statuses and times only; no pane, page or vault text' },
      }),
      route('GET /v1/pulls/:project/:repo/runs/:runId', {
        minimum: 'operator',
        caller: 'person',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: { skip: 'a read of one CI run’s job and step names, statuses and times' },
        guard: { none: 'job and step names, statuses and times only; no pane, page or vault text' },
      }),
      // G3 U5: the latest PR of each head branch, any state (ids, states, times, a commit id and a CI word; no text).
      route('GET /v1/pulls/:project/:repo/branches', {
        minimum: 'operator',
        caller: 'any',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: PULLS_AUDIT_SKIP.read,
        guard: {
          none: 'PR numbers, states, times, a head commit id and a CI word for named branches; no title, no text, no token',
        },
      }),
      // E6 · review threads of one PR (GraphQL; read when a PR page opens). Private code and strangers' text: not stored.
      route('GET /v1/pulls/:project/:repo/:number/threads', {
        minimum: 'operator',
        caller: 'any',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: { skip: 'a read of a PR the project already lists; nothing is changed and no secret is touched' },
        guard: { none: 'review threads of one PR: logins, comment text and links from GitHub; never a token' },
      }),
      // E4: one pull request with its conversation and its checks. Reading it reads private code, so `filesystem.use`.
      route('GET /v1/pulls/:project/:repo/:number', {
        minimum: 'operator',
        caller: 'person',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: { skip: 'a read of one pull request; nothing is changed and no text is recorded' },
        guard: {
          none: 'GitHub text (a title, a description, comments) and counts; no pane, page or vault text, and no token',
        },
      }),
      // E5: the files of a PR. Private code, so `filesystem.use`, never cached by anything shared.
      route('GET /v1/pulls/:project/:repo/:number/files', {
        minimum: 'operator',
        caller: 'person',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: { skip: "a read of a pull request's changed files; nothing is changed" },
        guard: {
          none: 'file paths, counts and diff text of a repository the project holds; no pane, page or vault text',
        },
      }),
      // E7: posts to GitHub AS THE PERSON (their connected account). Person only: a ferret is refused `owner_only`.
      // Each records its own audit line through Gate (ids only, never the body), so the declarative record is skipped.
      route('POST /v1/pulls/:project/:repo/:number/comment', POST_ROUTE),
      route('POST /v1/pulls/:project/:repo/:number/reply', POST_ROUTE),
      route('POST /v1/pulls/:project/:repo/:number/line-comment', POST_ROUTE),
      route('GET /v1/pulls/:project/:repo/:number/poster', {
        minimum: 'operator',
        caller: 'person',
        capability: PULLS_CAPS.read,
        noStore: true,
        audit: PULLS_AUDIT_SKIP.read,
        guard: PULLS_GUARD_POST,
      }),
    ],
  },

  ui: {
    screens: [
      // E3: the list of open PRs per project (and the watch switch). The nav entry sits after Projects (35).
      screen('pulls', { path: 'pulls', nav: { label: 'PRs & CI', icon: 'git-pull-request', order: 37 } }),
      // E4: the PR page.
      screen('pull', { path: 'pulls/:project/:repo/:number' }),
      // E9 (CI run page): one workflow run's jobs, steps and timing. No nav entry: a run is reached from a PR's CI tab.
      screen('ci-run', { path: 'pulls/:project/:repo/runs/:runId' }),
    ],
  },

  data: {
    // Private code (diffs): `0600` files in `0700` folders, bounded, deleted with the project or account.
    state: [PULLS_CACHE, WATCH_STATE],
    // E2: which projects are watched and which events notify.
    config: [PullsConfigDef],
    publishes: [PullsChanged],
    // A removed project or account takes its cache with it, at once (not on the next sweep).
    subscribes: [ProjectRemoved, GitAccountDisconnected],
  },

  // Private code: no ferret reaches the cache through any root.
  privacy: { private: ['cache', 'watch'] },

  permissions: { roots: [], spawn: [], network: [] },
});
