import { describe, expect, test } from 'bun:test';
import { testHost } from '@ferretry/kernel/testing';
import { emptyVault } from '../support/fake-vault.ts';
import { LoginChangeError, LoginChangesPort, LoginEnvImportPort, LoginsPort } from '../../contract/index.ts';
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
      const api = host.provided(LoginChangesPort);
      const staged = await api.stage({ kind: 'login.label', id: 'team', label: 'Team' });
      const read = await host.request('GET', `/v1/logins/changes/${staged.id}`);
      const viaPort = (await api.stage({ kind: 'login.enable', id: 'ghost' }).catch(caught => caught)) as unknown;
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

describe('the Logins port that takes an imported harness environment', () => {
  test('writes plain text to the login file in effect, keeps what is there, and writes no raw secret', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const api = host.provided(LoginEnvImportPort);
      const env = {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        GH_TOKEN: '${secret:GH_TOKEN}',
        CLAUDE_CONFIG_DIR: '/elsewhere',
      };
      const first = await api.import({ login: 'work', harness: 'claude-code', env });
      expect(first).toMatchObject({ outcome: 'written', added: ['ANTHROPIC_BASE_URL'], kept: [] });
      expect(first.outcome === 'written' ? first.skipped.map(entry => entry.name) : []).toEqual([
        'GH_TOKEN',
        'CLAUDE_CONFIG_DIR',
      ]);
      // The second import reads the file the first one wrote: it is already there.
      expect(await api.import({ login: 'work', harness: 'claude-code', env })).toMatchObject({
        outcome: 'unchanged',
        kept: ['ANTHROPIC_BASE_URL'],
      });
      const raw = await api.import({
        login: 'work',
        harness: 'claude-code',
        env: { OPENAI_API_KEY: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' },
      });
      expect(raw.outcome).toBe('unchanged');
      expect(JSON.stringify(raw)).not.toContain('sk-proj');
      expect(await api.import({ login: 'team', harness: 'claude-code', env })).toEqual({
        outcome: 'refused',
        reason: 'the login team is not a claude-code login',
      });
    } finally {
      await host.stop();
    }
  });

  test('holds a secret reference for the owner when the caller is not the owner, and says so', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const answer = await host
        .provided(LoginEnvImportPort)
        .import({ login: 'work', harness: 'claude-code', env: { ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}' } });
      expect(answer).toMatchObject({ outcome: 'held', added: ['ANTHROPIC_API_KEY'] });
      expect(JSON.stringify(answer)).toContain('only the owner may add');
    } finally {
      await host.stop();
    }
  });
});
