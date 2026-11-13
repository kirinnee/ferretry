/**
 * Pack mode over the ports the OTHER plugins really provide. Packs once declared its own port named `usage` with methods
 * (`logins()`, `paneLimits()`) that Usage's real port does not have: the real object was handed over under that name and
 * every `fy recommend`, `fy guide show` and `fy guide inventory` threw a TypeError, answered as a bare 500 that logged
 * nothing. This host gives Packs the REAL shape of Usage's port and Logins' port, through Packs' own composition.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { fakeUsage } from '@ferretry/plugin-usage/contract/testing';
import daemon from '../../../daemon/index.ts';

async function host(uses: Record<string, unknown>) {
  return await testHost({ plugins: [daemon], fakes: { ferrets: new FakeFerrets() }, uses });
}

const realProviders = () => ({ usage: fakeUsage(), logins: fakeLogins([sampleLogin('work')]) });

describe('Pack mode with the real Usage and Logins ports', () => {
  test('the settings page, the inventory and a recommendation each answer, and say where the routing prompt came from', async () => {
    const h = await host(realProviders());
    try {
      const view = await h.request('GET', '/v1/pack');
      expect(view.status).toBe(200);
      const inventory = await h.request('GET', '/v1/pack/inventory');
      expect(inventory.status).toBe(200);
      const recommended = await h.request('POST', '/v1/pack/recommend', { body: {} });
      expect(recommended.status).toBe(200);
      expect(recommended.json<{ routing: unknown }>().routing).toBeDefined();
    } finally {
      await h.stop();
    }
  });

  test('a provider that throws is logged with its cause and answered in a sentence, never as a bare 500', async () => {
    const failing = {
      ...fakeLogins([sampleLogin('work')]),
      list: async () => Promise.reject(new Error('the login store is damaged')),
    };
    const h = await host({ usage: fakeUsage(), logins: failing });
    try {
      const answer = await h.request('GET', '/v1/pack');
      expect(answer.status).toBe(503);
      expect(answer.json<{ code: string; error: string }>()).toMatchObject({ code: 'pack_unavailable' });
      expect(answer.body).not.toContain('the daemon failed to handle this request');
      expect(answer.body).not.toContain('login store is damaged');
      const logged = h.logs.filter(entry => entry.level === 'error').map(entry => entry.message);
      expect(logged.some(message => message.includes('the login store is damaged'))).toBe(true);
    } finally {
      await h.stop();
    }
  });
});
