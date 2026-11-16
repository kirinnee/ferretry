/**
 * The vault port the real Logins plugin reads for "is the secret this environment login names stored?" is NAMES ONLY.
 * The fake vault below holds a seeded value and records every method called on it; the real plugin is booted over it,
 * asked for its logins, and the test proves (a) only `names` was ever called, (b) the PRODUCTION port itself (the
 * `secretNames` function the plugin hands to the status service, observed as the status service receives it, not the
 * fake vault's own answer) returns EXACTLY the stored names: a set of name strings with no value of the seeded secret in
 * any element or in its serialisation, (c) what the plugin sent out holds no seeded value, and (d) the answer is right:
 * Ready where the name is stored, Needs sign-in where it is not. The seeded value is synthetic.
 */
import { expect, spyOn, test } from 'bun:test';
import type { VaultApi } from '@ferretry/core-vault/contract';
import { testHost } from '@ferretry/kernel/testing';
import { OwnedLoginStore } from '../../../daemon/adapters/credentials/owned-store.ts';
import daemon from '../../../daemon/index.ts';

const SEEDED_NAME = 'SEEDED_PROVIDER_KEY';
const SEEDED_VALUE = 'sk-ant-FAKE-SEEDED-VAULT-VALUE-000000000000';

function vaultHolding(): { readonly vault: VaultApi; readonly calls: string[]; readonly answers: unknown[] } {
  const calls: string[] = [];
  const answers: unknown[] = [];
  const store = new Map([[SEEDED_NAME, SEEDED_VALUE]]);
  const refuse = (method: string) => async (): Promise<never> => {
    calls.push(method);
    throw new Error(`the test vault serves no value (${method})`);
  };
  const vault = {
    names: async () => {
      calls.push('names');
      const answer = [...store.keys()].map(name => ({
        name,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }));
      answers.push(answer);
      return answer;
    },
    has: refuse('has'),
    put: refuse('put'),
    remove: refuse('remove'),
    run: refuse('run'),
    authorizeFetch: refuse('authorizeFetch'),
    childEnvironment: refuse('childEnvironment'),
    raiseInput: refuse('raiseInput'),
    cancelInput: refuse('cancelInput'),
    inputState: refuse('inputState'),
  } as unknown as VaultApi;
  return { vault, calls, answers };
}

/**
 * Observes the production `secretNames` port where the plugin gives it to the status service: the real function is
 * wrapped, not replaced, and everything it returns is recorded as it left the port (after the plugin's own transformation
 * of the vault's answer).
 */
function observePort(): { readonly returned: (ReadonlySet<string> | undefined)[]; readonly restore: () => void } {
  const returned: (ReadonlySet<string> | undefined)[] = [];
  const original = OwnedLoginStore.prototype.statusPorts;
  const spy = spyOn(OwnedLoginStore.prototype, 'statusPorts').mockImplementation(function (
    this: OwnedLoginStore,
    options: Parameters<OwnedLoginStore['statusPorts']>[0],
  ) {
    const port = options.secretNames;
    return original.call(this, {
      ...options,
      ...(port === undefined
        ? {}
        : {
            secretNames: async () => {
              const result = await port();
              returned.push(result);
              return result;
            },
          }),
    });
  });
  return { returned, restore: () => spy.mockRestore() };
}

test('the names-only vault port reaching the real logins plugin never returns a value', async () => {
  const held = vaultHolding();
  const port = observePort();
  const host = await testHost({
    plugins: [daemon],
    fakes: { vault: held.vault },
    config: {
      logins: {
        stored: {
          harness: 'claude-code',
          store: 'environment',
          env: { ANTHROPIC_API_KEY: `\${secret:${SEEDED_NAME}}` },
        },
        missing: {
          harness: 'claude-code',
          store: 'environment',
          env: { ANTHROPIC_API_KEY: '${secret:NOT_STORED_KEY}' },
        },
      },
    },
  });
  try {
    const listed = await host.request('GET', '/v1/logins');
    expect(listed.status).toBe(200);
    const logins = listed.json<{ logins: { id: string; status?: { word: string; reason?: string } }[] }>().logins;
    const wordOf = (id: string) => logins.find(login => login.id === id)?.status?.word;
    expect(wordOf('stored')).toBe('ready');
    expect(wordOf('missing')).toBe('needs_sign_in');

    // Only the names method was ever asked; every value-bearing method was left alone.
    expect(held.calls.length).toBeGreaterThan(0);
    expect(new Set(held.calls)).toEqual(new Set(['names']));
    // What the vault returned is names and times: strings that are names, and no value of the seeded secret anywhere in
    // the answer, its serialisation, or what the plugin sent out.
    for (const answer of held.answers) {
      expect(JSON.stringify(answer)).not.toContain(SEEDED_VALUE);
      for (const summary of answer as readonly { name: unknown }[]) expect(summary.name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    }
    expect(listed.body).not.toContain(SEEDED_VALUE);

    // The PRODUCTION port's own result: asked, and every answer is EXACTLY the stored names (an exact set, so an extra
    // element such as a value fails it), all name-shaped, with no seeded value in an element or in the serialisation.
    expect(port.returned.length).toBeGreaterThan(0);
    for (const result of port.returned) {
      expect(result).toBeInstanceOf(Set);
      const names = [...(result ?? [])];
      expect(names).toEqual([SEEDED_NAME]);
      for (const name of names) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
      expect(JSON.stringify(names)).not.toContain(SEEDED_VALUE);
      expect(names.some(name => name.includes(SEEDED_VALUE))).toBe(false);
    }
  } finally {
    port.restore();
    await host.stop();
  }
});
