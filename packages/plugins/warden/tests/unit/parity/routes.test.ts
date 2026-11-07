import { describe, expect, test } from 'bun:test';
import { entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import { ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { ferret, owner } from '@ferretry/kernel/testing';
import manifest from '../../../manifest.ts';
import { wardenHost } from './host.ts';

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
