import { expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import cli from '../../cli/index.ts';
import type { GitAccount } from '../../contract/index.ts';

test('disconnect CLI separates an uncertain upload fingerprint from confirmed keys needing deletion', async () => {
  const fingerprint = 'A'.repeat(40);
  const account: GitAccount = {
    id: 'gha_1',
    provider: 'github',
    githubId: 1,
    login: 'synthetic',
    scopes: [],
    keys: {},
    createdAt: '2026-11-19T00:00:00.000Z',
  };
  const client = {
    call: async (route: string) =>
      route === 'GET /v1/git-accounts'
        ? [account]
        : {
            id: account.id,
            removed: true,
            keysLeftOnProvider: [],
            gpgUploadsToCheck: [fingerprint],
            revokeAt: 'https://github.com/settings/applications',
          },
  } as unknown as PluginClient;
  const out: string[] = [];
  const half = cli.build?.({
    manifest: cli.manifest,
    client,
    io: {
      out: text => {
        out.push(text);
      },
      err: () => {},
      isTty: false,
    },
  });
  expect(await half?.verbs['git account rm']?.({ args: ['synthetic'], options: {} })).toBe(0);
  expect(out.join('\n')).toContain(fingerprint);
  expect(out.join('\n')).toContain('confirm who registered each key before taking any action');
  expect(out.join('\n')).not.toContain('delete them');
});
