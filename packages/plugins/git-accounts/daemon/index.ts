import { milliseconds } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import {
  GIT_ACCOUNT_KEYS,
  GIT_ACCOUNT_TOKENS,
  GitAccountDisconnected,
  GitAccountsConfigFile,
  GitAccountsConfigSchema,
  isGpgKey,
  keptHere,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { FetchGithubHttp } from './adapters/github-http.ts';
import { gitAccountRoutes } from './routes.ts';
import { psAgentProcesses } from './adapters/agent-processes.ts';
import { rootGhShimFolder, rootRunFolder } from './adapters/run-folder.ts';
import { accountLaunchParts } from './features/launch/parts.ts';
import { GpgSigners } from './features/gpg-keys/signer.ts';
import { GpgKeyService } from './features/gpg-keys/service.ts';
import { AgentSupervisor, type RunFolder } from './features/ssh-keys/agents.ts';
import type { AgentProcessTable } from './features/ssh-keys/sweep.ts';
import { GhRunner } from './features/gh-run/gh-runner.ts';
import { ghLocator } from './lib/gh-locator.ts';
import { programLocator } from './lib/program-locator.ts';
import { ghShimLaunchParts } from './features/gh-shim/parts.ts';
import { closeGhConfig, type GhShimFolders, installGhShim } from './features/gh-shim/shim.ts';
import { ghRunRoutes } from './features/gh-run/routes.ts';
import { sshKeyRoutes } from './features/ssh-keys/routes.ts';
import { SshKeyService } from './features/ssh-keys/service.ts';
import { AccountBook } from './lib/accounts.ts';
import { accountForFolder } from './lib/account-for-folder.ts';
import { AccountLocks } from './lib/account-locks.ts';
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
      const locks = new AccountLocks();
      const book = new AccountBook(
        kernel.state,
        needs.sealed.open(kernel.state, GIT_ACCOUNT_TOKENS),
        () => kernel.clock.now(),
        locks,
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
      // `gh` (a token), `ssh-agent` and `ssh-add` (the PRIVATE KEY on stdin) are found the same way: outside the state home, absolute.
      const locatorPorts = {
        home: () => kernel.paths.home(),
        daemonPath: () => kernel.hostFacts.launchGuard().searchPath,
        which: (name: string, options: { readonly directories: readonly string[] }) =>
          kernel.paths.which(name, options),
        stateHomeHolding: (path: string) => kernel.paths.stateHomeHolding(path),
        bindProgram: (path: string) => kernel.paths.bindProgram(path),
      };
      const sshPrograms = {
        'ssh-agent': programLocator({ name: 'ssh-agent', trustedWith: 'an account key' }, locatorPorts),
        'ssh-add': programLocator({ name: 'ssh-add', trustedWith: 'an account key' }, locatorPorts),
      };
      // GnuPG receives public packets only. Private packets stay in the daemon's memory signer.
      const gnupg = new GpgSigners(kernel.spawn, runFolder, kernel.log, kernel.clock, {
        gpg: programLocator({ name: 'gpg', trustedWith: 'an account key' }, locatorPorts),
        curl: programLocator({ name: 'curl', trustedWith: 'a signing payload' }, locatorPorts),
      });
      // A daemon that died uncleanly left its agents running: the first start (and the warm below) ends this daemon's own.
      const agents = new AgentSupervisor(
        kernel.spawn,
        runFolder,
        kernel.clock,
        kernel.log,
        async name => (await sshPrograms[name]()).program,
        {
          table: overrides.agentProcesses ?? psAgentProcesses(kernel.spawn),
          uid: process.getuid?.() ?? -1,
          self: process.pid,
        },
      );
      kernel.lifecycle.onStop(() => agents.stopAll());
      kernel.lifecycle.onStop(() => gnupg.stopAll());
      // Bind the canonical system-managed client, never a pane-writable executable found on PATH.
      const client = programLocator(
        { name: kernel.identity.binaries.client, trustedWith: "a ferret's session" },
        locatorPorts,
      );
      const shimFolder = overrides.runFolder ?? rootGhShimFolder(kernel.roots);
      // Repair before each launch. Only overlapping installs share a promise; a completed install is never cached.
      let shim: Promise<GhShimFolders | undefined> | undefined;
      const shimFolders = (): Promise<GhShimFolders | undefined> => {
        shim ??= client()
          .then(async found => {
            const pinned = await kernel.paths.bindProgram(found.program);
            if (pinned === undefined) throw new Error('GitHub client unavailable');
            return await installGhShim(shimFolder, pinned);
          })
          .catch(() => {
            kernel.log.warn('git-accounts: GitHub client unavailable; ferret launch will be refused');
            return undefined;
          })
          .finally(() => {
            shim = undefined;
          });
        return shim;
      };
      void shimFolders();
      // Late-bound: the key service asks the account service (for the API on an account's behalf), which in turn tells
      // the key service when an account goes. Neither holds a token.
      const keys: { service?: SshKeyService; gpg?: GpgKeyService } = {};
      const service = new GitAccountsService(
        book,
        http,
        kernel.spawn,
        kernel.scratch,
        id => kernel.events.publish(GitAccountDisconnected, { id }),
        async id => {
          const results = await Promise.allSettled([keys.service?.forgetLocked(id), keys.gpg?.forgetLocked(id)]);
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        },
        // The `gh` that gets a token is the real one: never a file in the state home, even if the daemon's own PATH names the shim folder.
        ghLocator(locatorPorts),
        (id, work) => locks.run(id, work),
      );
      // One sealed document and one handle for both kinds of key: two handles over one file would race each other's writes.
      const sealedKeys = needs.sealed.open(kernel.state, GIT_ACCOUNT_KEYS);
      const keyService = new SshKeyService(service, sealedKeys, agents, () => kernel.identity.daemonName, locks);
      keys.service = keyService;
      const gpgService = new GpgKeyService(
        service,
        sealedKeys,
        gnupg,
        () => kernel.identity.daemonName,
        (id, work) => keyService.exclusive(id, work),
      );
      keys.gpg = gpgService;
      const gh = new GhRunner({
        accounts: service,
        help: args => service.help(args),
        projects: async () => (await projects.current()?.list()) ?? [],
        workFolder: async ferret => (await ferrets.current()?.workFolder(ferret as never))?.folder,
        audit: async draft => await needs.gate.audit(draft),
      });
      // A ferret that was started before this daemon was keeps its socket path: bring each agent back at it.
      void service
        .list()
        .then(async accounts => {
          const own = accounts.filter(
            account =>
              account.keys.ssh?.source === 'generated' ||
              (account.keys.signing?.source === 'generated' && !isGpgKey(account.keys.signing)),
          );
          const gpgOwn = accounts.filter(account => isGpgKey(account.keys.signing) && keptHere(account.keys.signing));
          // Leftover agents first, so a warmed agent never meets (or is mistaken for) one an earlier run left behind.
          if (own.length > 0) await agents.sweepLeftovers();
          await keyService.warm(
            own.map(account => account.id),
            account => kernel.log.warn('git-accounts: an account agent was not brought back at boot', { account }),
          );
          await gpgService.warm(
            gpgOwn.map(account => account.id),
            account => kernel.log.warn('git-accounts: an account GPG key was not brought back at boot', { account }),
          );
        })
        .catch(() => undefined);
      return {
        routes: {
          ...gitAccountRoutes(flows, service, async draft => await needs.gate.audit(draft)),
          ...sshKeyRoutes(keyService, gpgService),
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
                gpg: account => gpgService.launchKit(account),
              }),
            },
            {
              id: 'git-accounts-gh',
              item: ghShimLaunchParts(
                shimFolders,
                async folder => {
                  const linked = accountForFolder(folder, (await projects.current()?.list()) ?? [], () => true);
                  return linked !== undefined;
                },
                () => closeGhConfig(shimFolder),
              ),
            },
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
