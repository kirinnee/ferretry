import { milliseconds } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import {
  GIT_ACCOUNT_KEYS,
  GIT_ACCOUNT_TOKENS,
  GitAccountDisconnected,
  GitAccountsConfigFile,
  GitAccountsConfigSchema,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { FetchGithubHttp } from './adapters/github-http.ts';
import { gitAccountRoutes } from './routes.ts';
import { AgentSupervisor } from './features/ssh-keys/agents.ts';
import { sshKeyRoutes } from './features/ssh-keys/routes.ts';
import { SshKeyService } from './features/ssh-keys/service.ts';
import { AccountBook } from './lib/accounts.ts';
import { GithubDeviceFlows } from './lib/device-flow.ts';
import { GitAccountsService } from './lib/service.ts';

/**
 * Git accounts (daemon half): connects GitHub accounts by device flow and holds each token in its own sealed document.
 * The sealed handle is opened over THIS plugin's state port and given to the account book alone. The SSH keys (B3) have
 * their own sealed document, opened here and given to the key service alone.
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
    const agents = new AgentSupervisor(kernel.spawn, kernel.scratch, kernel.clock, kernel.log);
    kernel.lifecycle.onStop(() => agents.stopAll());
    // Late-bound: the key service asks the account service (for the API on an account's behalf), which in turn tells
    // the key service when an account goes. Neither holds a token.
    const keys: { service?: SshKeyService } = {};
    const service = new GitAccountsService(
      book,
      http,
      kernel.spawn,
      kernel.scratch,
      id => kernel.events.publish(GitAccountDisconnected, { id }),
      async id => {
        await keys.service?.forget(id);
      },
    );
    const keyService = new SshKeyService(
      service,
      needs.sealed.open(kernel.state, GIT_ACCOUNT_KEYS),
      agents,
      () => kernel.identity.daemonName,
    );
    keys.service = keyService;
    return {
      routes: {
        ...gitAccountRoutes(flows, service, async draft => await needs.gate.audit(draft)),
        ...sshKeyRoutes(keyService),
      },
      provides: {
        gitAccounts: {
          list: () => service.list(),
          api: (account, call) => service.api(account, call),
          run: (account, spec) => service.run(account, spec),
          recordKeys: (account, keys) => service.recordKeys(account, keys),
          agentSocket: account => keyService.agentSocket(account),
          knownHostsFile: () => agents.knownHostsFile(),
        },
      },
    };
  },
});
