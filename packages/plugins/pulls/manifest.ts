import { definePlugin, route, screen } from '@ferretry/kernel/manifest';
import { GitAccountDisconnected, GitAccountsPort } from '@ferretry/plugin-git-accounts/contract';
import { ProjectsPort, ProjectRemoved } from '@ferretry/plugin-projects/contract';
import { PULLS_CACHE, PULLS_CAPS, PULLS_WORDS } from './contract/index.ts';

/**
 * PRs & CI (r9 track E): a project's pull requests and CI, inside Ferretry. E1 is the base the other units stand on: the
 * contract, a GitHub client over `git-accounts`' api seam (ETag reads, `Link` paging, a rate budget) and the per-project
 * cache. E1 filed no route; each later unit adds its own route declaration here and one registration line to `daemon/routes.ts`. E8 files the CI reads; E4 files the PR page (route and screen).
 *
 * NO TOKEN. This plugin names an account by id and `git-accounts` places the token on the request; nothing here can
 * read one. It needs no network permission of its own for the same reason: it never makes the request.
 */
export default definePlugin({
  id: 'pulls',
  title: 'PRs & CI',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: PULLS_WORDS,

  needs: { gitAccounts: GitAccountsPort, projects: ProjectsPort },

  actions: {
    routes: [
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
    ],
  },

  ui: {
    screens: [
      // E4: the PR page. E3 adds the list screen beside it.
      screen('pull', { path: 'pulls/:project/:repo/:number' }),
      // E9 (CI run page): one workflow run's jobs, steps and timing. No nav entry: a run is reached from a PR's CI tab.
      screen('ci-run', { path: 'pulls/:project/:repo/runs/:runId' }),
    ],
  },

  data: {
    // Private code (diffs): `0600` files in `0700` folders, bounded, deleted with the project or account.
    state: [PULLS_CACHE],
    // A removed project or account takes its cache with it, at once (not on the next sweep).
    subscribes: [ProjectRemoved, GitAccountDisconnected],
  },

  // Private code: no ferret reaches the cache through any root.
  privacy: { private: ['cache'] },

  permissions: { roots: [], spawn: [], network: [] },
});
