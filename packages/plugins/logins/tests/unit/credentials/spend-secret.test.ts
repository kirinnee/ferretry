import { expect, test } from 'bun:test';
import type { LoginView } from '../../../contract/index.ts';
import { spendSecretOf } from '../../../daemon/lib/credentials/spend-secret.ts';

const login = (store: string, variables: readonly unknown[]): LoginView =>
  ({ id: 'glm', store, environment: store === 'environment' ? { variables } : undefined }) as unknown as LoginView;

const KEYED = [
  { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
  { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
  { name: 'TWO', kind: 'secret', secrets: ['A_KEY', 'B_KEY'], set: true },
  { name: 'HIDDEN', kind: 'hidden' },
];

test('S12 S62 a login’s key is the one secret its OWN record makes the named variable from, never a caller’s word', () => {
  expect(spendSecretOf(login('environment', KEYED), 'ANTHROPIC_AUTH_TOKEN')).toBe('ZAI_API_KEY');
});

test('S12 S62 a variable that is plain, hidden, made from several secrets, or absent names no secret to spend', () => {
  for (const variable of ['ANTHROPIC_BASE_URL', 'HIDDEN', 'TWO', 'NOT_THERE', 'ZAI_API_KEY'])
    expect([variable, spendSecretOf(login('environment', KEYED), variable)]).toEqual([variable, undefined]);
});

test('S12 S62 a login that is not made from environment variables, or no login at all, names no secret', () => {
  expect(spendSecretOf(login('host', KEYED), 'ANTHROPIC_AUTH_TOKEN')).toBeUndefined();
  expect(spendSecretOf(undefined, 'ANTHROPIC_AUTH_TOKEN')).toBeUndefined();
});
