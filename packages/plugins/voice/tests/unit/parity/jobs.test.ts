/** The J rows of docs/design/rebuild-parity.tsv assigned to Voice, each named by its id. */
import { describe, expect, test } from 'bun:test';
import { owner } from '@ferretry/kernel/testing';
import { voiceHost } from './host.ts';

describe('the voice timers', () => {
  test('J-0182 a cleanup request carries its timeout to the Vault holder, which aborts at it; a timeout is said so', async () => {
    const { host, sent } = await voiceHost(undefined, () => ({ kind: 'timeout' }));
    const response = await host.request('POST', '/v1/stt/enhance', {
      body: { text: 'helo wold', provider: 'groq' },
      as: owner(),
    });
    expect(sent[0]?.timeoutMs).toBeGreaterThan(0);
    expect(response.json()).toMatchObject({ code: 'timeout' });
    // No timer of its own is left behind: the daemon half schedules no job.
    expect(host.jobIds()).toEqual([]);
  });

  test.skip('J-0243 the warden runtime’s debounced trigger (lib/warden/runtime.ts) … pending port: warden (not a Voice timer; mis-assigned)', () => {});
});
