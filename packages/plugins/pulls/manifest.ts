import { definePlugin } from '@ferretry/kernel/manifest';
import { GitAccountsPort } from '@ferretry/plugin-git-accounts/contract';
import { ProjectsPort, ProjectRemoved } from '@ferretry/plugin-projects/contract';
import { PULLS_CACHE, PULLS_WORDS } from './contract/index.ts';

/**
 * PRs & CI (r9 track E): a project's pull requests and CI, inside Ferretry. E1 is the base the other units stand on: the
 * contract, a GitHub client over `git-accounts`' api seam (ETag reads, `Link` paging, a rate budget) and the per-project
 * cache. It files no route yet; each later unit adds its own registration line to `daemon/index.ts`.
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
  kinds: ['command'],
  words: PULLS_WORDS,

  needs: { gitAccounts: GitAccountsPort, projects: ProjectsPort },

  data: {
    // Private code (diffs): `0600` files in `0700` folders, bounded, deleted with the project or account.
    state: [PULLS_CACHE],
    // A removed project takes its cache with it.
    subscribes: [ProjectRemoved],
  },

  // Private code: no ferret reaches the cache through any root.
  privacy: { private: ['cache'] },

  permissions: { roots: [], spawn: [], network: [] },
});
