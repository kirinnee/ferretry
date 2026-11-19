import { describe, expect, test } from 'bun:test';
import type { Needer } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { emptyVault } from '../support/fake-vault.ts';
import {
  LoginChangeError,
  LoginChangesPort,
  LoginEnvImportPort,
  LoginsPort,
  type LoginEnvCaller,
} from '../../contract/index.ts';
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

/** The only plugin handed a working door, as the kernel names it to the provider. */
const RUNTIMES: Needer = { id: 'runtimes', permissions: {}, ownedSecretReferences: () => new Set() };
const OTHER: Needer = { id: 'someone-else', permissions: {}, ownedSecretReferences: () => new Set() };
const caller = (refuse: 'fleet' | 'secrets' | undefined = undefined): LoginEnvCaller => ({
  governance: {
    governed: true,
    decide: demand =>
      ({ allowed: (demand as { capability?: string }).capability !== refuse, refusal: 'denied' }) as never,
  },
});
const plain = (block: Record<string, string>) => Object.entries(block).map(([name, value]) => ({ name, value }));

describe('the Logins port that takes an imported harness environment', () => {
  test('writes plain text and a minted reference to the login file in effect, keeps what is there, and writes no raw secret', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const api = host.provided(LoginEnvImportPort, RUNTIMES);
      const base = {
        caller: caller(),
        login: 'work',
        harness: 'claude-code',
        plain: plain({ ANTHROPIC_BASE_URL: 'https://gateway.example.test', CLAUDE_CONFIG_DIR: '/elsewhere' }),
        minted: [{ name: 'GH_TOKEN', secretName: 'GH_TOKEN' }],
      } as const;
      const first = await api.import(base);
      expect(first).toMatchObject({ outcome: 'written', added: ['ANTHROPIC_BASE_URL'], kept: [] });
      expect(first.outcome === 'written' ? first.skipped.map(entry => entry.name) : []).toEqual([
        'CLAUDE_CONFIG_DIR',
        'GH_TOKEN',
      ]);
      // The second import reads the file the first one wrote: it is already there.
      expect(await api.import(base)).toMatchObject({ outcome: 'unchanged', kept: ['ANTHROPIC_BASE_URL'] });
      const raw = await api.import({
        ...base,
        plain: plain({ OPENAI_API_KEY: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }),
        minted: [],
      });
      expect(raw.outcome).toBe('unchanged');
      expect(JSON.stringify(raw)).not.toContain('sk-proj');
      expect(await api.import({ ...base, login: 'team' })).toEqual({
        outcome: 'refused',
        reason: 'the login team is not a claude-code login',
      });
    } finally {
      await host.stop();
    }
  });

  test('adds to a login Logins just created for the apply, so a fresh machine gets its login and its env', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: { logins: {} } });
    try {
      const changes = host.provided(LoginChangesPort);
      const view = await changes.stage({ kind: 'login.add', id: 'claude-you', harness: 'claude-code', store: 'host' });
      await changes.apply(view.id);
      const api = host.provided(LoginEnvImportPort, RUNTIMES);
      const answer = await api.import({
        caller: caller(),
        login: 'claude-you',
        harness: 'claude-code',
        plain: plain({ ANTHROPIC_BASE_URL: 'https://gateway.example.test' }),
        minted: [{ name: 'GITHUB_TOKEN', secretName: 'GITHUB_TOKEN' }],
        ticked: ['GITHUB_TOKEN'],
      });
      expect(answer).toMatchObject({ outcome: 'held', added: ['ANTHROPIC_BASE_URL', 'GITHUB_TOKEN'] });
      const login = await host.provided(LoginsPort).get('claude-you' as never);
      expect(String(login?.id)).toBe('claude-you');
    } finally {
      await host.stop();
    }
  });

  test('is a working door for Runtimes alone: every other plugin is refused and nothing is written', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      for (const needer of [OTHER, undefined]) {
        const api =
          needer === undefined ? host.provided(LoginEnvImportPort) : host.provided(LoginEnvImportPort, needer);
        const answer = await api.import({
          caller: caller(),
          login: 'work',
          harness: 'claude-code',
          plain: plain({ REGION: 'eu' }),
          minted: [],
        });
        expect(answer.outcome).toBe('refused');
      }
      const real = host.provided(LoginEnvImportPort, RUNTIMES);
      expect(
        await real.import({ caller: caller(), login: 'work', harness: 'claude-code', plain: [], minted: [] }),
      ).toMatchObject({ outcome: 'unchanged' });
    } finally {
      await host.stop();
    }
  });

  test('asks the caller live: no fleet.configure refuses, and no secrets.configure refuses a bound reference only', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const api = host.provided(LoginEnvImportPort, RUNTIMES);
      const mint = [{ name: 'ANTHROPIC_API_KEY', secretName: 'ANTHROPIC_API_KEY' }];
      const asked = { login: 'work', harness: 'claude-code', plain: plain({ REGION: 'eu' }), minted: mint } as const;
      expect((await api.import({ ...asked, caller: caller('fleet') })).outcome).toBe('refused');
      expect((await api.import({ ...asked, caller: caller('secrets') })).outcome).toBe('refused');
      expect(await api.import({ ...asked, caller: caller('secrets'), minted: [] })).toMatchObject({
        outcome: 'written',
        added: ['REGION'],
      });
    } finally {
      await host.stop();
    }
  });

  test('holds a secret reference for the owner when the caller is not the owner, and then refuses to add to the login with the held edit', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: files });
    try {
      const api = host.provided(LoginEnvImportPort, RUNTIMES);
      const answer = await api.import({
        caller: caller(),
        login: 'work',
        harness: 'claude-code',
        plain: [],
        minted: [{ name: 'ANTHROPIC_API_KEY', secretName: 'ANTHROPIC_API_KEY' }],
      });
      expect(answer).toMatchObject({ outcome: 'held', added: ['ANTHROPIC_API_KEY'] });
      expect(JSON.stringify(answer)).toContain('only the owner may add');
      // The edit waits for the owner, so a later import neither drops it nor replaces a key in it.
      const later = await api.import({
        caller: caller(),
        login: 'work',
        harness: 'claude-code',
        plain: plain({ REGION: 'eu' }),
        minted: [],
      });
      expect(later).toMatchObject({ outcome: 'refused' });
      expect(later.outcome === 'refused' ? later.reason : '').toContain('waiting for the owner');
    } finally {
      await host.stop();
    }
  });
});
