import { describe, expect, it } from 'bun:test';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { LoginsApi, LoginView } from '@ferretry/plugin-logins/contract';
import { HostHarnessScanner } from '../../../daemon/adapters/host-harness-scan.ts';
import { planImport } from '../../../daemon/lib/account/import.ts';

const scan = async (logins: Pick<LoginsApi, 'list'>) => {
  const paths: string[] = [];
  const touch = (path: string): undefined => {
    paths.push(path);
    if (/auth\.json|\.credentials\.json/.test(path)) throw new Error('credential file reached');
    return undefined;
  };
  const scanner = new HostHarnessScanner({
    userHome: '/fixture/home',
    files: {
      stat: async path => touch(path),
      lstat: async path => touch(path),
      readText: async path => touch(path),
      readBytes: async path => touch(path),
      list: async path => touch(path),
    },
    commands: { resolve: name => `/fixture/bin/${name}` },
    logins,
    maxDocumentBytes: 4096,
  });
  return { scans: await scanner.scan(), paths };
};

describe('opaque host sign-in scan', () => {
  it('uses only safe Logins facts and never opens a credential file', async () => {
    const facts = fakeLogins([
      sampleLogin('you', { email: 'you@example.test' }),
      sampleLogin('codex', {
        harness: 'codex',
        harnesses: ['codex'],
        status: { ...sampleLogin('codex').status, word: 'refresh_due' },
      }),
    ]);
    const { scans, paths } = await scan(facts);
    expect(scans.map(row => row.login)).toEqual([
      { state: 'signed-in', email: 'you@example.test' },
      { state: 'refresh-due' },
    ]);
    expect(paths.some(path => /auth\.json|\.credentials\.json/.test(path))).toBe(false);
  });

  it('reports unknown for unregistered, non-host, ambiguous and inconclusive host facts', async () => {
    const row = sampleLogin('you');
    const variants: readonly (readonly LoginView[])[] = [
      [],
      [{ ...row, store: 'ferretry' }],
      [row, sampleLogin('other')],
      [{ ...row, status: { ...row.status, lastCheckInconclusive: true } }],
      [{ ...row, status: { ...row.status, word: 'checking' } }],
    ];
    for (const rows of variants) {
      const { scans } = await scan(fakeLogins(rows));
      expect(scans[0]?.login.state).toBe('unknown');
    }
  });

  it('keeps a failing facts port unknown and retains an opaque store host pointer in the import plan', async () => {
    const { scans } = await scan({
      list: async () => {
        throw new Error('unavailable');
      },
    });
    expect(scans.map(row => row.login.state)).toEqual(['unknown', 'unknown']);
    const plan = planImport(scans, { digest: text => text });
    expect(Object.values(plan.credentials).map(login => login.store)).toEqual(['host', 'host']);
    expect(JSON.stringify(plan.notes)).toContain('unknown');
  });

  it('reports a definitive missing sign-in only when Logins says so', async () => {
    const row = sampleLogin('you');
    const { scans } = await scan(fakeLogins([{ ...row, status: { ...row.status, word: 'needs_sign_in' } }]));
    expect(scans[0]?.login.state).toBe('not-signed-in');
  });
});
