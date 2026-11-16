import { describe, expect, it } from 'bun:test';
import { listSecretNames, putSecret, reasonOf } from '../../../app/lib/clients.ts';
import { recordingClient } from '../../support/app/client.ts';

describe('the secrets the Browser tab asks the daemon about', () => {
  it('lists the names filed on the machine and their health, never a value', async () => {
    const { client, calls } = recordingClient(() => ({
      health: 'ready',
      secrets: [{ name: 'github' }, { name: 'okta', value: 'kept out' }],
    }));
    const listed = await listSecretNames(client);
    expect(listed.health).toBe('ready');
    expect([...listed.names]).toEqual(['github', 'okta']);
    expect(calls.map(call => call.route)).toEqual(['GET /v1/secrets']);
  });

  it('refuses a list that does not name its health', async () => {
    const { client } = recordingClient(() => ({ secrets: [] }));
    await expect(listSecretNames(client)).rejects.toThrow();
  });

  it('files a secret with a post of its name and value, and reads nothing back', async () => {
    const { client, calls } = recordingClient(() => ({}));
    await putSecret(client, 'github', 's3cret');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe('POST /v1/secrets');
    expect(calls[0]?.init?.body).toEqual({ name: 'github', value: 's3cret' });
  });

  it('turns a refusal into its sentence, or a stand-in when it said nothing', () => {
    expect(reasonOf(new Error('  no way  '))).toBe('no way');
    expect(reasonOf(new Error('   '))).toBe('This machine did not answer.');
    expect(reasonOf('not an error')).toBe('This machine did not answer.');
  });
});
