import { describe, expect, test } from 'bun:test';
import { testHost } from '@ferretry/kernel/testing';
import { emptyVault } from '../support/fake-vault.ts';
import { LoginChangeError, LoginsPort } from '../../contract/index.ts';
import { loginsConformance } from '../../contract/testing/index.ts';
import daemon from '../../daemon/index.ts';

const files = {
  logins: {
    work: { harness: 'claude-code', store: 'host' },
    team: { harness: 'codex', store: 'ferretry' },
  },
};

describe('the real Logins passes the same conformance suite as the fake', () => {
  test('list, get, quota, presets and models answer on the contract with sign-ins that cannot be read', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const api = host.provided(LoginsPort);
      const result = await loginsConformance(() => api);
      expect(result.ok ? true : result.error).toBe(true);
      const list = await api.list();
      expect(list.logins.map((login: { id: string }) => login.id)).toEqual(['team', 'work']);
    } finally {
      await host.stop();
    }
  });
});

describe('the real Logins served through the host', () => {
  test('the list, the presets and the models answer on their paths, and a sign-in for a login nobody named is refused', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const list = await host.request('GET', '/v1/logins');
      const presets = await host.request('GET', '/v1/logins/presets');
      const models = await host.request('GET', '/v1/models');
      const ghost = await host.request('POST', '/v1/logins/sign-in', { body: { loginId: 'ghost' } });
      const stray = await host.request('POST', '/v1/logins/sign-in', { body: { loginId: 'work', wrapper: '/bin/sh' } });

      expect([list.status, presets.status, models.status]).toEqual([200, 200, 200]);
      expect(presets.json<{ presets: unknown[] }>().presets.length).toBeGreaterThan(10);
      expect(ghost.status).toBe(409);
      expect(stray.status).toBe(400);
      expect(list.body).not.toMatch(/accessToken|refreshToken|sk-/u);
    } finally {
      await host.stop();
    }
  });
});

describe('the Logins port changes through the same service as the routes', () => {
  test('a change staged through the port is the one the route reads, and a refusal is the same code on both', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const api = host.provided(LoginsPort);
      const staged = await api.changes.stage({ kind: 'login.label', id: 'team', label: 'Team' });
      const read = await host.request('GET', `/v1/logins/changes/${staged.id}`);
      const viaPort = (await api.changes
        .stage({ kind: 'login.enable', id: 'ghost' })
        .catch(caught => caught)) as unknown;
      const viaRoute = await host.request('POST', '/v1/logins/changes', {
        body: { kind: 'login.enable', id: 'ghost' },
      });

      expect(read.status).toBe(200);
      expect(read.json<{ id: string; summary: string }>()).toMatchObject({ id: staged.id, summary: staged.summary });
      expect(viaPort).toBeInstanceOf(LoginChangeError);
      expect((viaPort as LoginChangeError).code).toBe('login_change_refused');
      expect(viaRoute.status).toBe(409);
      expect(viaRoute.json<{ code: string }>().code).toBe('login_change_refused');
    } finally {
      await host.stop();
    }
  });
});
