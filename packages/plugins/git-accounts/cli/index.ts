import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import type { GitAccount, GitAccountRemoved, GitDeviceFlow, GitDeviceFlowStatus } from '../contract/index.ts';
import { seconds } from '@ferretry/std';
import manifest from '../manifest.ts';
import { ghVerbs } from './gh.ts';

const OK = 0;
const FAILED = 1;
const USAGE = 2;

const wantsJson = (invocation: VerbInvocation): boolean => invocation.options.json === true;

function describe(account: GitAccount): string {
  const keys = [account.keys.ssh === undefined ? '' : 'ssh', account.keys.signing === undefined ? '' : 'signing']
    .filter(Boolean)
    .join('+');
  return `${account.id}  ${account.login}${account.name === undefined ? '' : ` (${account.name})`}  keys: ${keys || 'none'}`;
}

/**
 * Git accounts (cli half): `fy git account add|ls|rm`. Every answer is names and ids; no route behind these returns a
 * token. `add` shows the code and polls the flow until GitHub answers.
 */
export default implementCli(manifest, {
  build: context => {
    const { client, io, sleep } = context;
    return {
      verbs: {
        ...ghVerbs(context),
        'git account add': async invocation => {
          const flow = await client.call<GitDeviceFlow>('POST /v1/git-accounts/github/device');
          if (wantsJson(invocation)) io.out(JSON.stringify({ flow }));
          else
            io.out(`Open ${flow.verificationUri} and type:  ${flow.userCode}\nWaiting for you to authorize Ferretry…`);
          let interval = flow.interval;
          for (;;) {
            if (sleep === undefined) {
              io.err('this shell cannot wait; run the command again after you have authorized');
              return FAILED;
            }
            await sleep(seconds(interval));
            const status = await client.call<GitDeviceFlowStatus>('GET /v1/git-accounts/github/device/:flowId', {
              params: { flowId: flow.flowId },
            });
            if (status.status === 'pending' || status.status === 'slow_down') {
              interval = status.interval;
              continue;
            }
            if (wantsJson(invocation)) io.out(JSON.stringify({ result: status }));
            if (status.status === 'done') {
              if (!wantsJson(invocation)) io.out(`Connected ${status.login} (${status.accountId}).`);
              return OK;
            }
            io.err(
              status.status === 'denied' ? 'The sign-in was denied on GitHub.' : 'The code expired; run it again.',
            );
            return FAILED;
          }
        },

        'git account ls': async invocation => {
          const accounts = await client.call<readonly GitAccount[]>('GET /v1/git-accounts');
          if (wantsJson(invocation)) io.out(JSON.stringify(accounts, null, 2));
          else io.out(accounts.length === 0 ? 'No Git accounts connected.' : accounts.map(describe).join('\n'));
          return OK;
        },

        'git account rm': async invocation => {
          const wanted = invocation.args[0]?.trim() ?? '';
          if (wanted === '') {
            io.err('name the account: its id (gha_…) or its login');
            return USAGE;
          }
          const accounts = await client.call<readonly GitAccount[]>('GET /v1/git-accounts');
          const found = accounts.find(
            account => account.id === wanted || account.login.toLowerCase() === wanted.toLowerCase(),
          );
          if (found === undefined) {
            io.err(`no Git account ${wanted}; \`fy git account ls\` lists them`);
            return FAILED;
          }
          const removed = await client.call<GitAccountRemoved>('DELETE /v1/git-accounts/:id', {
            params: { id: found.id },
          });
          if (wantsJson(invocation)) io.out(JSON.stringify(removed, null, 2));
          else {
            io.out(`Disconnected ${found.login}.`);
            if (removed.keysLeftOnProvider.length > 0)
              io.out(
                `These keys could not be removed on GitHub; delete them at github.com/settings/keys: ${removed.keysLeftOnProvider.join(', ')}`,
              );
            if (removed.gpgUploadsToCheck.length > 0)
              io.out(
                `These GPG uploads have unknown outcomes. Compare these public fingerprints at github.com/settings/keys and confirm who registered each key before taking any action: ${removed.gpgUploadsToCheck.join(', ')}`,
              );
            io.out(`To fully revoke Ferretry's access, open ${removed.revokeAt}`);
          }
          return OK;
        },
      },
    };
  },
});
