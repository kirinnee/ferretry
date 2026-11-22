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
import { psAgentProcesses } from './adapters/agent-processes.ts';
import { rootRunFolder } from './adapters/run-folder.ts';
import { accountLaunchParts } from './features/launch/parts.ts';
import { AgentSupervisor, type RunFolder } from './features/ssh-keys/agents.ts';
import type { AgentProcessTable } from './features/ssh-keys/sweep.ts';
import { GhRunner } from './features/gh-run/gh-runner.ts';
import { ghLocator } from './lib/gh-locator.ts';
import { ghShimLaunchParts } from './features/gh-shim/parts.ts';
import { type GhShimFolders, installGhShim } from './features/gh-shim/shim.ts';
import { ghRunRoutes } from './features/gh-run/routes.ts';
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
export interface GitAccountsOverrides {
  /** A test's own folder for the agents (the kernel's test roots are an in-memory map, which a real ssh-agent cannot bind in). */
  readonly runFolder?: RunFolder;
  /** A test's own process table for the boot sweep: it must never see (or signal) a real process of the machine it runs on. */
  readonly agentProcesses?: AgentProcessTable;
}

export function gitAccountsDaemon(overrides: GitAccountsOverrides = {}) {
  return implementDaemon(manifest, {
    build: ({ needs, uses, kernel }) => {
      const { projects, ferrets } = uses;
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
      // The agents live in this plugin's own `downloads` folder: the same path on every run (a ferret outlives a restart).
      const runFolder = overrides.runFolder ?? rootRunFolder(kernel.roots.root('downloads'));
      // A daemon that died uncleanly left its agents running: the first start (and the warm below) ends this daemon's own.
      const agents = new AgentSupervisor(kernel.spawn, runFolder, kernel.clock, kernel.log, {
        table: overrides.agentProcesses ?? psAgentProcesses(kernel.spawn),
        uid: process.getuid?.() ?? -1,
        self: process.pid,
      });
      kernel.lifecycle.onStop(() => agents.stopAll());
      // Ferretry's `gh` (B10): the shim is written at boot and again whenever a launch finds it was not (a failure is not kept).
      let shim: Promise<GhShimFolders | undefined> | undefined;
      const shimFolders = (): Promise<GhShimFolders | undefined> => {
        shim ??= installGhShim(runFolder, kernel.identity.binaries.client).then(
          folders => {
            if (folders === undefined) shim = undefined;
            return folders;
          },
          () => {
            shim = undefined;
            kernel.log.warn("git-accounts: Ferretry's gh shim could not be written, so ferrets keep no gh shim");
            return undefined;
          },
        );
        return shim;
      };
      void shimFolders();
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
        // The `gh` that gets a token is the real one: never a file in the state home, even if the daemon's own PATH names the shim folder.
        ghLocator({
          daemonPath: () => kernel.hostFacts.launchGuard().searchPath,
          which: (name, options) => kernel.paths.which(name, options),
          stateHomeHolding: path => kernel.paths.stateHomeHolding(path),
        }),
      );
      const keyService = new SshKeyService(
        service,
        needs.sealed.open(kernel.state, GIT_ACCOUNT_KEYS),
        agents,
        () => kernel.identity.daemonName,
      );
      keys.service = keyService;
      const gh = new GhRunner({
        accounts: service,
        projects: async () => (await projects.current()?.list()) ?? [],
        workFolder: async ferret => (await ferrets.current()?.workFolder(ferret as never))?.folder,
        audit: async draft => await needs.gate.audit(draft),
      });
      // A ferret that was started before this daemon was keeps its socket path: bring each agent back at it.
      void service
        .list()
        .then(async accounts => {
          const own = accounts.filter(
            account => account.keys.ssh?.source === 'generated' || account.keys.signing?.source === 'generated',
          );
          // Leftover agents first, so a warmed agent never meets (or is mistaken for) one an earlier run left behind.
          if (own.length > 0) await agents.sweepLeftovers();
          await keyService.warm(
            own.map(account => account.id),
            account => kernel.log.warn('git-accounts: an account agent was not brought back at boot', { account }),
          );
        })
        .catch(() => undefined);
      return {
        routes: {
          ...gitAccountRoutes(flows, service, async draft => await needs.gate.audit(draft)),
          ...sshKeyRoutes(keyService),
          ...ghRunRoutes(gh),
        },
        hooks: {
          // A ferret in a project linked to an account pushes and signs as it (r9 B4); every ferret gets Ferretry's `gh` (B10).
          'launch.parts': () => [
            {
              id: 'git-accounts',
              item: accountLaunchParts({
                projects: async () => (await projects.current()?.list()) ?? [],
                accounts: () => service.list(),
                kit: account => keyService.launchKit(account),
              }),
            },
            { id: 'git-accounts-gh', item: ghShimLaunchParts(shimFolders) },
          ],
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
}

export default gitAccountsDaemon();
