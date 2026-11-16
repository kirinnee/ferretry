import { describe, expect, it } from 'bun:test';
import { parseSecretList } from '../../../app/lib/secrets.ts';

const T = '2026-01-01T00:00:00.000Z';
const summary = { name: 'ACME_TOKEN', createdAt: T, updatedAt: T };
const list = (secrets: readonly unknown[]) => ({ v: 1, health: 'ready', secrets, references: [] });

describe('S5 the secret-name list is parsed by the Vault contract, strictly', () => {
  it('accepts a Vault listing of names and times', () => {
    expect(parseSecretList(list([summary])).secrets.map(secret => secret.name)).toEqual(['ACME_TOKEN']);
  });

  it('refuses an entry that carries a value or a digest (use, never read)', () => {
    expect(() => parseSecretList(list([{ ...summary, value: 'hunter2hunter2' }]))).toThrow();
    expect(() => parseSecretList(list([{ ...summary, digest: 'abc' }]))).toThrow();
  });

  it('refuses a list that carries an extra field, and a name outside the grammar', () => {
    expect(() => parseSecretList({ ...list([summary]), value: 'x' })).toThrow();
    expect(() => parseSecretList(list([{ ...summary, name: 'lower-case' }]))).toThrow();
  });
});
