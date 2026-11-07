/** The Voice daemon half on the kernel's test host, over a Vault fake that holds the given keys and records each send. */
import type { AuthorizedOutcome, OutboundHttpRequest, SecretName } from '@ferretry/core-vault/contract';
import { FakeVault, type FakeTransport } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import voice from '../../../daemon/index.ts';

export const GROQ_KEY = 'gsk_test_0123456789abcdef';
export const CEREBRAS_KEY = 'csk_test_0123456789abcdef';

export const chat = (content: string): AuthorizedOutcome => ({
  kind: 'completion',
  payload: { choices: [{ message: { content }, finish_reason: 'stop' }] },
});

export async function voiceHost(
  keys: Readonly<Record<string, string>> = { GROQ_API_KEY: GROQ_KEY },
  transport: (request: OutboundHttpRequest) => AuthorizedOutcome = () => chat('Hello, world.'),
  config: Record<string, unknown> = { postProcessing: { provider: 'groq' } },
) {
  const sent: OutboundHttpRequest[] = [];
  const recording: FakeTransport = request => {
    sent.push(request);
    return transport(request);
  };
  const vault = new FakeVault(undefined, recording);
  for (const [name, value] of Object.entries(keys)) await vault.put(name as SecretName, value);
  const host = await testHost({ plugins: [voice], fakes: { vault }, config: { 'voice.yaml': config } });
  return { host, sent, vault };
}
