import { milliseconds } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { GIT_ACCOUNT_TOKENS, GitAccountsConfigFile, GitAccountsConfigSchema } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { FetchGithubHttp } from './adapters/github-http.ts';
import { gitAccountRoutes } from './routes.ts';
import { AccountBook } from './lib/accounts.ts';
import { GithubDeviceFlows } from './lib/device-flow.ts';
import { GitAccountsService } from './lib/service.ts';

/**
 * Git accounts (daemon half): connects GitHub accounts by device flow and holds each token in its own sealed document.
 * The sealed handle is opened over THIS plugin's state port and given to the account book alone.
 */
export default implementDaemon(manifest, {
  build: ({ needs, kernel }) => {
    const book = new AccountBook(kernel.state, needs.sealed.open(kernel.state, GIT_ACCOUNT_TOKENS), () =>
      kernel.clock.now(),
    );
    const http = new FetchGithubHttp(kernel.fetch);
    const settings = () => kernel.config.file(GitAccountsConfigFile) ?? GitAccountsConfigSchema.parse({});
    const flows = new GithubDeviceFlows({
      http,
      book,
      clientId: () => settings().github.clientId,
      nowMs: () => kernel.clock.nowMs(),
      after: (ms, fn) => kernel.clock.after(milliseconds(ms), fn),
    });
    const service = new GitAccountsService(book, http, kernel.spawn, kernel.scratch);
    return {
      routes: gitAccountRoutes(flows, service, async draft => await needs.gate.audit(draft)),
      provides: {
        gitAccounts: {
          list: () => service.list(),
          api: (account, call) => service.api(account, call),
          run: (account, spec) => service.run(account, spec),
          recordKeys: (account, keys) => service.recordKeys(account, keys),
        },
      },
    };
  },
});
