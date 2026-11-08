import { describe, expect, test } from 'bun:test';
import { entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import { ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { ferret, owner } from '@ferretry/kernel/testing';
import { WARDEN_CONFIG } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { realWardenConfig, wardenHost } from './host.ts';

const route = (key: string) => manifest.actions.routes.find(candidate => candidate.key === key);

describe('route parity', () => {
  test('R-0208 R-0209 R-0207 the three reads are warden-scoped, authenticated and never cached', () => {
    for (const key of ['GET /v1/warden/status', 'GET /v1/warden/verdicts', 'GET /v1/warden/report'])
      expect(route(key)).toMatchObject({ minimum: 'authenticated', caller: 'any', noStore: true });
  });

  test('R-0408 R-0206 a run and the settings read are operator routes on the warden capability', () => {
    expect(route('POST /v1/warden/run')).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
    expect(route('GET /v1/warden/config')).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
  });

  test('R-0232 R-0406 R-0407 changing settings, investigating and leaving alone are for a person', () => {
    expect(route('PATCH /v1/warden/config')).toMatchObject({ minimum: 'operator', caller: 'person' });
    expect(route('POST /v1/warden/investigate')).toMatchObject({ minimum: 'operator', caller: 'person' });
    expect(route('POST /v1/warden/leave')).toMatchObject({ minimum: 'operator', caller: 'person' });
    expect(route('PATCH /v1/warden/config')?.capability).toMatchObject({ axis: 'configure' });
    expect(route('POST /v1/warden/leave')?.capability).toMatchObject({ axis: 'configure' });
  });

  test('R-0208 status answers the flags, spend and totals a live warden (a ferret) reads to understand what it was sent to triage', async () => {
    const { host } = await wardenHost();

    const response = await host.request('GET', '/v1/warden/status', { as: ferret('w1') });

    expect(response.status).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>())).toEqual(
      expect.arrayContaining(['config', 'flags', 'triage', 'investigations', 'actions', 'blessings']),
    );
  });

  test('R-0209 verdicts are an empty list before any report', async () => {
    const { host } = await wardenHost();

    const response = await host.request('GET', '/v1/warden/verdicts', { as: owner() });

    expect(response.json()).toEqual([]);
  });

  test('R-0207 a report needs a path, and one that is not there is 404 warden_report_not_found', async () => {
    const { host } = await wardenHost();

    const missing = await host.request('GET', '/v1/warden/report', { as: owner() });
    const absent = await host.request('GET', '/v1/warden/report', { query: { path: 'x.md' }, as: owner() });

    expect(missing.status).toBe(400);
    expect(absent.status).toBe(404);
    expect(absent.json<{ code: string }>().code).toBe('warden_report_not_found');
  });

  test('R-0206 the settings read answers the effective settings with warnings', async () => {
    const { host } = await wardenHost({ config: { enabled: false } });

    const view = (await host.request('GET', '/v1/warden/config', { as: owner() })).json<{
      config: { enabled: boolean };
      warnings: string[];
    }>();

    expect(view.config.enabled).toBe(false);
    expect(Array.isArray(view.warnings)).toBe(true);
  });

  test('R-0232 a settings change goes through the kernel config write port and answers the new settings', async () => {
    const { host } = await wardenHost();

    const response = await host.request('PATCH', '/v1/warden/config', { body: { enabled: false }, as: owner() });

    expect(response.status).toBe(200);
    expect(response.json<{ config: { enabled: boolean } }>().config.enabled).toBe(false);
  });

  test('R-0232 on the real kernel writer a settings change is written into warden.yaml key by key, comments kept', async () => {
    const real = realWardenConfig();
    await real.handEdit('# the owner keeps notes here\nmaxAssignedWardens: 1\n');
    const { host } = await wardenHost({ realConfig: real });

    const response = await host.request('PATCH', '/v1/warden/config', { body: { enabled: false }, as: owner() });

    expect(response.status).toBe(200);
    expect(response.json<{ held?: string[] }>().held).toBeUndefined();
    expect(
      (await host.request('GET', '/v1/warden/config', { as: owner() })).json<{ config: { enabled: boolean } }>(),
    ).toMatchObject({ config: { enabled: false } });
    const text = await real.text();
    expect(text).toContain('# the owner keeps notes here');
    expect(text).toContain('enabled: false');
    // Every setting is written from the settings in effect, but a default nobody stated is not written in.
    expect(text).not.toContain('revive');
    expect(text).not.toContain('caps');
  });

  test('R-0232 GAP (the hold comes from a writer with no judge, not parity) a loosening no judge lets apply is held: the answer shows the settings in effect and journals no change', async () => {
    // Today the owner's own save is acknowledged and in effect at once. This writer has no judge (as for any call Gate's
    // judgeConfigWrite does not let apply), so the loosening is held.
    const real = realWardenConfig();
    await real.handEdit('enabled: false\n');
    const { host } = await wardenHost({ realConfig: real });

    const response = await host.request('PATCH', '/v1/warden/config', { body: { enabled: true }, as: owner() });

    expect(response.status).toBe(200);
    expect(response.json<{ held?: string[] }>().held).toEqual(['the warden is switched on']);
    expect(response.json<{ config: { enabled: boolean } }>().config.enabled).toBe(false);
    expect(
      (await host.request('GET', '/v1/warden/config', { as: owner() })).json<{ config: { enabled: boolean } }>(),
    ).toMatchObject({ config: { enabled: false } });
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'held', inEffect: true });
    expect(host.logs.some(entry => entry.message === 'fleet.warden_config_changed')).toBe(false);
  });

  test('R-0232 an owner lowering a cap while switching the warden on is held lowers it in both versions at once, as today: the warden stays off and the held edit stays held', async () => {
    const real = realWardenConfig();
    await real.handEdit('enabled: false\ncaps:\n  investigationUsdPerDay: 2\n');
    await real.handEdit('enabled: true\ncaps:\n  investigationUsdPerDay: 2\n');
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'held' });
    const { host } = await wardenHost({ realConfig: real });

    const response = await host.request('PATCH', '/v1/warden/config', {
      body: { caps: { investigationUsdPerDay: 1 } },
      as: owner(),
    });

    expect(response.status).toBe(200);
    const view = (await host.request('GET', '/v1/warden/config', { as: owner() })).json<{
      config: { enabled: boolean; caps: { investigationUsdPerDay: number } };
    }>();
    expect(view.config).toMatchObject({ enabled: false, caps: { investigationUsdPerDay: 1 } });
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({
      state: 'held',
      sentences: ['the warden is switched on'],
    });
    expect(await real.text()).toContain('enabled: true');
    expect(await real.text()).toContain('investigationUsdPerDay: 1');
  });

  test('R-0232 an owner saving another cap while a raised jevUsdPerDay is held saves it in both versions, and the held edit is NOT discarded or put into effect', async () => {
    const real = realWardenConfig();
    await real.handEdit('caps:\n  jevUsdPerDay: 0.5\n');
    await real.handEdit('caps:\n  jevUsdPerDay: 5\n');
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'held' });
    const { host } = await wardenHost({ realConfig: real });

    const response = await host.request('PATCH', '/v1/warden/config', {
      body: { caps: { investigationUsdPerDay: 1 } },
      as: owner(),
    });

    expect(response.status).toBe(200);
    expect(real.port.file(WARDEN_CONFIG)).toMatchObject({ caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 1 } });
    expect(await real.text()).toContain('jevUsdPerDay: 5');
    expect(await real.text()).toContain('investigationUsdPerDay: 1');
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'held', inEffect: true });
  });

  test("R-0232 where Gate's judge lets the owner at the machine apply, the owner switching the warden on is in effect at once, as today", async () => {
    const real = realWardenConfig({ judge: 'owner-at-machine' });
    await real.handEdit('enabled: false\n');
    const { host } = await wardenHost({ realConfig: real });

    const response = await host.request('PATCH', '/v1/warden/config', { body: { enabled: true }, as: owner() });

    expect(response.status).toBe(200);
    expect(response.json<{ held?: string[]; config: { enabled: boolean } }>()).toMatchObject({
      config: { enabled: true },
    });
    expect(response.json<{ held?: string[] }>().held).toBeUndefined();
    expect(
      (await host.request('GET', '/v1/warden/config', { as: owner() })).json<{ config: { enabled: boolean } }>(),
    ).toMatchObject({ config: { enabled: true } });
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'valid' });
    expect(host.logs.some(entry => entry.message === 'fleet.warden_config_changed')).toBe(true);
  });

  test("R-0232 an owner save beside an edit the kernel HOLDS (one a ferret could have made) is in effect at once in both versions, as today, and never puts the held edit into effect, even where Gate's judge would apply the owner's call", async () => {
    // The risk: the kernel patches the DISK text, so the judge is asked about the whole patched file, held edit included.
    const exposed = realWardenConfig({ judge: 'owner-at-machine' });
    await exposed.handEdit('caps:\n  jevUsdPerDay: 0.5\n');
    await exposed.handEdit('caps:\n  jevUsdPerDay: 5\n');
    const direct = await exposed.port.write(WARDEN_CONFIG, undefined, { patch: { maxAssignedWardens: 1 } });
    expect(direct.kind).toBe('written');
    expect(exposed.port.file(WARDEN_CONFIG)).toMatchObject({ caps: { jevUsdPerDay: 5 } });

    // Through Warden's route the owner's save is written to both versions (writeAsOwner): only the owner's patch is judged.
    const real = realWardenConfig({ judge: 'owner-at-machine' });
    await real.handEdit('caps:\n  jevUsdPerDay: 0.5\n');
    await real.handEdit('caps:\n  jevUsdPerDay: 5\n');
    const { host } = await wardenHost({ realConfig: real });

    const response = await host.request('PATCH', '/v1/warden/config', { body: { maxAssignedWardens: 1 }, as: owner() });

    expect(response.status).toBe(200);
    expect(real.port.file(WARDEN_CONFIG)).toMatchObject({ maxAssignedWardens: 1, caps: { jevUsdPerDay: 0.5 } });
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'held', inEffect: true });
    expect(await real.text()).toContain('jevUsdPerDay: 5');
    expect(await real.text()).toContain('maxAssignedWardens: 1');

    // A SECTION save merges into both versions' section: the held price stays held, the owner's sub-key is in effect.
    const section = await host.request('PATCH', '/v1/warden/config', {
      body: { caps: { investigationUsdPerDay: 3 } },
      as: owner(),
    });
    expect(section.status).toBe(200);
    expect(real.port.file(WARDEN_CONFIG)).toMatchObject({ caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 3 } });
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'held', inEffect: true });
    expect(await real.text()).toContain('jevUsdPerDay: 5');
    expect(await real.text()).toContain('investigationUsdPerDay: 3');
  });

  test("R-0232 GAP an owner save over a BROKEN warden.yaml overwrites its other keys with the settings in effect, so a loosening planted beside the broken value is never put into effect, even where Gate's judge would apply the owner's call", async () => {
    const real = realWardenConfig({ judge: 'owner-at-machine' });
    await real.handEdit('enabled: false\ncaps:\n  investigationUsdPerDay: 2\n');
    // Something (a ferret, say) switches the warden on next to a value the schema refuses: the file is invalid.
    await real.handEdit('enabled: true\ncaps:\n  investigationUsdPerDay: -1\n');
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'invalid', inEffect: true });
    const { host } = await wardenHost({ realConfig: real });

    // The owner fixes the cap from the form.
    const response = await host.request('PATCH', '/v1/warden/config', {
      body: { caps: { investigationUsdPerDay: 1 } },
      as: owner(),
    });

    expect(response.status).toBe(200);
    const answer = response.json<{
      held?: string[];
      config: { enabled: boolean; caps: { investigationUsdPerDay: number } };
    }>();
    expect(answer.held).toBeUndefined();
    expect(answer.config).toMatchObject({ enabled: false, caps: { investigationUsdPerDay: 1 } });
    const view = (await host.request('GET', '/v1/warden/config', { as: owner() })).json<{
      config: { enabled: boolean; caps: { investigationUsdPerDay: number } };
    }>();
    expect(view.config).toMatchObject({ enabled: false, caps: { investigationUsdPerDay: 1 } });
    expect(answer.config).toEqual(view.config);
    expect(real.port.file(WARDEN_CONFIG)).toMatchObject({ enabled: false, caps: { investigationUsdPerDay: 1 } });
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'valid' });
    expect(await real.text()).toContain('enabled: false');
    const journal = host.logs.filter(entry => entry.message === 'fleet.warden_config_changed');
    expect(journal.map(entry => entry.fields)).toEqual([{ fields: JSON.stringify(['caps']) }]);
  });

  test('R-0232 an owner save over a hand edit the kernel has not reloaded yet is refused 409 (try again) and the hand edit is kept', async () => {
    const real = realWardenConfig({ judge: 'owner-at-machine' });
    await real.handEdit('enabled: false\n');
    const { host } = await wardenHost({ realConfig: real });
    // A hand edit in ANOTHER section lands on disk inside the watcher's poll-and-settle window: not reloaded yet.
    real.plant('enabled: true\n');
    expect(real.port.fileState(WARDEN_CONFIG)).toMatchObject({ state: 'valid' });

    const response = await host.request('PATCH', '/v1/warden/config', {
      body: { caps: { investigationUsdPerDay: 1 } },
      as: owner(),
    });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('conflict');
    // nothing was applied or lost: the hand edit is still on disk and the settings in effect are as they were
    expect(await real.text()).toBe('enabled: true\n');
    expect(real.port.file(WARDEN_CONFIG)).toMatchObject({ enabled: false });
    expect(host.logs.some(entry => entry.message === 'fleet.warden_config_changed')).toBe(false);
  });

  test('R-0232 a ferret cannot change the warden settings: 403 and warden.yaml unchanged', async () => {
    const real = realWardenConfig();
    await real.handEdit('enabled: true\n');
    const { host } = await wardenHost({ realConfig: real });

    const response = await host.request('PATCH', '/v1/warden/config', { body: { enabled: false }, as: ferret('f1') });

    expect(response.status).toBe(403);
    expect(await real.text()).toBe('enabled: true\n');
  });

  test('R-0406 investigating a ferret nobody has is refused, and R-0407 leaving a clean one alone is refused', async () => {
    const { host, ferrets } = await wardenHost();
    ferrets.add({ id: ferretId('f1'), state: 'working', stateAt: T0 });

    const investigate = await host.request('POST', '/v1/warden/investigate', {
      body: { ferret: 'nobody' },
      as: owner(),
    });
    const leave = await host.request('POST', '/v1/warden/leave', {
      body: { ferret: 'f1', duration: '1h' },
      as: owner(),
    });

    expect([404, 409]).toContain(investigate.status);
    expect(leave.status).toBe(409);
  });

  test('R-0407 a flagged ferret can be left alone and the blessing shows on status', async () => {
    const { host, ferrets, asks, clock } = await wardenHost();
    ferrets.add({ id: ferretId('f1'), parent: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: T0 });
    await asks.raise({
      source: sourceKey('ferret'),
      entry: entryId('f1-q'),
      ref: {},
      kind: 'yesno',
      subject: 'Ship it?',
      why: 'a decision',
      raisedBy: { kind: 'ferret', ferret: 'f1' },
      ferret: 'f1',
    });
    await clock.advance(3 * 60 * 60 * 1000);
    await host.request('POST', '/v1/warden/run', { as: owner() });

    const left = await host.request('POST', '/v1/warden/leave', {
      body: { ferret: 'f1', duration: '1h' },
      as: owner(),
    });
    const status = (await host.request('GET', '/v1/warden/status', { as: owner() })).json<{
      blessings: { ferret: string }[];
    }>();

    expect(left.status).toBe(200);
    expect(status.blessings.map(blessing => blessing.ferret)).toEqual(['f1']);
  });
});
