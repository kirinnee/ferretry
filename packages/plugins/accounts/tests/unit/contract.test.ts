import { describe, expect, test } from 'bun:test';
import { accountsConformance, fakeAccounts } from '../../contract/testing/index.ts';
import { AccountsConfigSchema, SignInApprovalRefSchema, TerminalPlaceSchema } from '../../contract/index.ts';

accountsConformance(
  'fakeAccounts',
  () =>
    fakeAccounts([
      {
        id: 'si_0123456789abcdef',
        account: 'WORK_GITHUB',
        place: { kind: 'site', domains: ['github.com'], match: [] },
      },
    ]),
  'github.com',
);

describe('accounts wire', () => {
  test('ssh, scp and sftp name a destination; nothing else has one', () => {
    expect(TerminalPlaceSchema.safeParse({ kind: 'terminal', tool: 'ssh', host: 'box' }).success).toBe(false);
    expect(TerminalPlaceSchema.safeParse({ kind: 'terminal', tool: 'ssh', host: 'box', dest: 'box' }).success).toBe(
      true,
    );
    expect(TerminalPlaceSchema.safeParse({ kind: 'terminal', tool: 'psql', host: 'db', dest: 'db' }).success).toBe(
      false,
    );
  });
  test('a sign-in approval card names an id, never an account', () => {
    expect(SignInApprovalRefSchema.safeParse({ kind: 'rule-suspended', rule: `sr_${'0'.repeat(24)}` }).success).toBe(
      true,
    );
    expect(
      SignInApprovalRefSchema.safeParse({ kind: 'rule-suspended', rule: `sr_${'0'.repeat(24)}`, account: 'X' }).success,
    ).toBe(false);
  });
  test('a folder default has no dot segment', () => {
    expect(AccountsConfigSchema.safeParse({ folders: { '~/work/../x': { 'github.com': 'WORK' } } }).success).toBe(
      false,
    );
  });
});
