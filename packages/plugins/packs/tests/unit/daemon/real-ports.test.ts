/**
 * Pack mode over the ports the OTHER plugins really provide. Packs once declared its own port named `usage` with methods
 * (`logins()`, `paneLimits()`) that Usage's real port does not have: the real object was handed over under that name and
 * every `fy recommend`, `fy guide show` and `fy guide inventory` threw a TypeError, answered as a bare 500 that logged
 * nothing. This host gives Packs the REAL shape of Usage's port and Logins' port, through Packs' own composition.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { ModelCatalogsViewSchema } from '@ferretry/plugin-logins/contract';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { RuntimeIdSchema } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import { fakeUsage } from '@ferretry/plugin-usage/contract/testing';
import daemon from '../../../daemon/index.ts';
import { choice, runtime, tool } from './support.ts';

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

/**
 * A healthy machine: one signed-in Claude login, one agent runtime on it with a model, the Claude CLI installed, and the
 * login's model catalog. `fy recommend` must name that model and the command that starts it, through Packs' own composition
 * over the ports Runtimes and Logins really provide (their `catalog()`, `tools()` and `models()`).
 */
function healthyMachine() {
  const logins = {
    ...fakeLogins([sampleLogin('work-login')]),
    models: async () =>
      ModelCatalogsViewSchema.parse({
        published: { origin: 'https://example.invalid', enabled: false },
        catalogs: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            origin: 'built-in',
            verified: '2026-11-01',
            customIds: false,
            claude: [{ id: 'opus', label: 'Opus', tier: 'best', efforts: [], default: true }],
          },
        ],
      }),
  };
  const runtimes = fakeRuntimes();
  runtimes.setRuntimes([
    {
      id: RuntimeIdSchema.parse('work'),
      harness: 'claude-code',
      login: 'work-login',
      profile: 'default',
      agent: true,
      launch: { available: true },
    },
  ]);
  runtimes.setCatalog(
    [runtime('work', { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] })],
    [tool('claude-code', true)],
  );
  return { usage: fakeUsage(), logins, runtimes };
}

describe('Pack mode on a healthy machine', () => {
  test('fy recommend lists the ready model with the command that starts it', async () => {
    const h = await host(healthyMachine());
    try {
      const recommended = await h.request('POST', '/v1/pack/recommend', { body: {} });

      expect(recommended.status).toBe(200);
      const answer = recommended.json<{
        available: { model: string; runtime: string; ready: boolean; command?: string }[];
        next?: string;
      }>();
      expect(answer.available.map(option => option.model)).toContain('opus');
      expect(answer.available[0]?.runtime).toBe('work');
      expect(answer.available[0]).toMatchObject({ ready: true, model: 'opus', runtime: 'work' });
      expect(answer.available[0]?.command).toContain('--runtime work');
      expect(answer.available[0]?.command).toContain('--model opus');
      expect(answer.next).toBe(answer.available[0]?.command);
    } finally {
      await h.stop();
    }
  });

  test('with Runtimes off, no model is usable and the answer says so instead of failing', async () => {
    const { runtimes: _off, ...without } = healthyMachine();
    const h = await host(without);
    try {
      const recommended = await h.request('POST', '/v1/pack/recommend', { body: {} });

      expect(recommended.status).toBe(200);
      expect(recommended.json<{ available: unknown[] }>().available).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  test('a login a ferret is parked on with the harness’s own limit notice is not offered, though its windows look usable', async () => {
    const machine = healthyMachine();
    const ferrets = new FakeFerrets();
    // The REAL port's shape: the summary names the ferret and its login and carries no quota; the limit is what `prompt()`
    // answers (`FerretPrompt.limit`, which the real Ferrets fills from the session document).
    ferrets.add({ id: ferretId('f1'), state: 'working', login: 'work-login' } as never);
    ferrets.setPrompt(ferretId('f1'), {
      limit: { notice: 'You have hit your org’s monthly spend limit', spend: true },
    });
    const h = await testHost({ plugins: [daemon], fakes: { ferrets }, uses: machine });
    try {
      const recommended = await h.request('POST', '/v1/pack/recommend', { body: {} });

      expect(recommended.status).toBe(200);
      const option = recommended.json<{
        available: { ready: boolean; quota?: { state: string }; command?: string }[];
      }>().available[0];
      expect(option).toMatchObject({ ready: false, quota: { state: 'exhausted' } });
      expect(option?.command).toBeUndefined();
    } finally {
      await h.stop();
    }
  });

  test('a login whose ferret is working with no limit recorded is offered as before, and a past reset ends the limit', async () => {
    const machine = healthyMachine();
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1'), state: 'working', login: 'work-login' } as never);
    ferrets.add({ id: ferretId('f2'), state: 'working', login: 'work-login' } as never);
    ferrets.setPrompt(ferretId('f2'), { limit: { notice: 'old limit', spend: false, retryAt: 1 } });
    const h = await testHost({ plugins: [daemon], fakes: { ferrets }, uses: machine });
    try {
      const recommended = await h.request('POST', '/v1/pack/recommend', { body: {} });

      expect(recommended.json<{ available: { ready: boolean }[] }>().available[0]?.ready).toBe(true);
    } finally {
      await h.stop();
    }
  });
});
