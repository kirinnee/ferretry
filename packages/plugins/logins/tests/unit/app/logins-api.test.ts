import { describe, expect, it } from 'bun:test';
import { checkLogin, readLogins, readPresets, ROUTES, testLogin } from '../../../app/lib/logins-api.ts';
import { refreshLocalModels } from '../../../app/lib/local-models-api.ts';
import { login, loginList } from '../cli/fakes.ts';
import { type Call, scripted } from './support/client.ts';
import { localModelsFixture } from './support/local-models.ts';

describe('the login reads', () => {
  it('reads the list through the list route and parses it', async () => {
    const calls: Call[] = [];
    const client = scripted({ [ROUTES.list]: loginList(login()) }, calls);

    const list = await readLogins(client);

    expect(list.logins.map(entry => String(entry.id))).toEqual(['claude-you']);
    expect(calls.map(call => call.route)).toEqual(['GET /v1/logins']);
  });

  it('refuses a list that carries a field the contract does not name', async () => {
    const client = scripted({ [ROUTES.list]: { ...loginList(login()), accessToken: 'x' } });

    await expect(readLogins(client)).rejects.toThrow();
  });

  it('checks one login by id with an empty body', async () => {
    const calls: Call[] = [];
    const client = scripted({ [ROUTES.check]: login() }, calls);

    await checkLogin(client, 'claude-you');

    expect(calls[0]).toMatchObject({ route: ROUTES.check, params: { loginId: 'claude-you' }, body: {} });
  });

  it('tests one login, sending the consent only when it was given', async () => {
    const answer = {
      loginId: 'zai-glm',
      ok: true,
      code: 'ok',
      message: 'The provider accepted this login.',
      spent: 'nothing',
      at: '2026-10-16T08:00:00.000Z',
    };
    const calls: Call[] = [];
    const client = scripted({ [ROUTES.test]: answer }, calls);

    await testLogin(client, 'zai-glm');
    await testLogin(client, 'zai-glm', { allowInference: true });

    expect(calls.map(call => call.body)).toEqual([{}, { allowInference: true }]);
  });

  it('reads the presets', async () => {
    const client = scripted({ [ROUTES.presets]: { presets: [] } });

    expect(await readPresets(client)).toEqual({ presets: [] });
  });
});

describe('refreshLocalModels', () => {
  it('POSTs the refresh once and parses the daemon’s answer', async () => {
    const calls: Call[] = [];
    const answer = localModelsFixture('found');
    const client = scripted({ 'POST /v1/models/local/refresh': answer }, calls);

    expect(await refreshLocalModels(client)).toEqual(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({});
  });

  it('refuses an answer that is not the schema', async () => {
    const client = scripted({ 'POST /v1/models/local/refresh': { state: 'found' } });

    await expect(refreshLocalModels(client)).rejects.toThrow();
  });
});
