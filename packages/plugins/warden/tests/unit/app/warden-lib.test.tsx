import { describe, expect, it } from 'bun:test';
import { mount } from '@ferretry/app/testing';
import { FormField } from '../../../app/lib/form-parts.tsx';
import { ferretTitles } from '../../../app/lib/callsign.ts';
import { wardenClientOf } from '../../../app/lib/warden-client.ts';
import { daemonReach, homeClientFactory, wardenClientFactory } from '../../../app/lib/warden-clients.ts';
import { daemonConnection } from '../../../app/lib/machine.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { wardenConfig } from '../../support/app/warden.ts';

describe('FormField', () => {
  it('should show the daemon’s error beside the field as an alert, and nothing when there is none', async () => {
    const failed = await mount(
      <FormField error="must be a number" help="seconds" id="every" label="Every">
        <input id="every" />
      </FormField>,
    );
    const fine = await mount(
      <FormField error={null} id="every" label="Every">
        <input id="every" />
      </FormField>,
    );
    try {
      expect(failed.container.querySelector('[role="alert"]')?.textContent).toBe('must be a number');
      expect(failed.container.querySelector('.fy-action-form__help')?.textContent).toBe('seconds');
      expect(fine.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await failed.unmount();
      await fine.unmount();
    }
  });
});

describe('ferretTitles', () => {
  it('should title a ferret by its task, else its folder, else its callsign, else its id', () => {
    expect(ferretTitles({ id: 'x', name: 'ms-98', task: 'fix the badge' })).toEqual({
      title: 'fix the badge',
      ferret: 'Ms-98',
    });
    expect(ferretTitles({ id: 'x', name: 'ms-98', cwd: '/work/board/' })).toEqual({ title: 'board', ferret: 'Ms-98' });
    expect(ferretTitles({ id: 'x', name: 'ms-98' })).toEqual({ title: 'Ms-98', ferret: null });
    expect(ferretTitles({ id: 'x', cwd: '/work/board' })).toEqual({ title: 'board', ferret: null });
    expect(ferretTitles({ id: 'sess-1' })).toEqual({ title: 'sess-1', ferret: null });
  });
});

describe('wardenClientOf', () => {
  it('should parse what a settings patch answers', async () => {
    const config = wardenConfig();
    const calls: string[] = [];
    const client = wardenClientOf({
      call: async (route: string) => {
        calls.push(route);
        return { config, accounts: config.accounts, warnings: ['held'] };
      },
      subscribe: () => () => {},
    } as never);

    const view = await client.updateConfig({});

    expect(calls).toEqual(['PATCH /v1/warden/config']);
    expect(view.warnings).toEqual(['held']);
  });
});

describe('daemonReach', () => {
  const own = { call: async () => 'own' } as unknown as PluginClient;
  const other = { call: async () => 'other' } as unknown as PluginClient;
  const home = daemonConnection({ daemonId: 'd1', daemonName: 'laptop' });
  const reach = daemonReach(home, own, new Map([['d2', other]]));

  it('should answer the half’s own client for its daemon, and the Warden’s row client for another', async () => {
    expect(await reach(home)).toBe(own);
    expect(await reach(daemonConnection({ daemonId: 'd2', daemonName: 'desk' }))).toBe(other);
  });

  it('should refuse, saying so, for a machine with no Warden row (not connected yet, or the Warden off there)', async () => {
    await expect(reach(daemonConnection({ daemonId: 'd3', daemonName: 'tower' }))).rejects.toThrow(
      'This device cannot reach the Warden on that machine yet.',
    );
  });
});

describe('daemonReach — a machine still connecting (m2)', () => {
  const own = { call: async () => 'own' } as unknown as PluginClient;
  const other = { call: async () => 'other' } as unknown as PluginClient;
  const home = daemonConnection({ daemonId: 'd1', daemonName: 'laptop' });
  const d2 = daemonConnection({ daemonId: 'd2', daemonName: 'desk' });

  it('m2 waits for the row of a machine that is still connecting, then answers it', async () => {
    const rows = new Map<string, PluginClient>();
    const reach = daemonReach(home, own, {
      clients: () => rows,
      whyNone: () => ({ waiting: true, line: 'Checking what this daemon offers…' }),
    });
    const pending = reach(d2);
    setTimeout(() => rows.set('d2', other), 150);
    expect(await pending).toBe(other);
  });

  it('m2 says the machine’s own sentence at once for a Warden that is paused or off there', async () => {
    const reach = daemonReach(home, own, {
      clients: () => new Map(),
      whyNone: () => ({ waiting: false, line: 'Warden is off on this daemon.' }),
    });
    await expect(reach(d2)).rejects.toThrow('Warden is off on this daemon.');
  });

  it('m2 gives up with the machine’s sentence when the wait runs out', async () => {
    const reach = daemonReach(home, own, {
      clients: () => new Map(),
      whyNone: () => ({ waiting: true, line: 'Checking what this daemon offers…' }),
      waitMs: 150,
    });
    await expect(reach(d2)).rejects.toThrow('Checking what this daemon offers…');
  });
});

describe('the Warden client factories', () => {
  const config = wardenConfig();
  const answering = (calls: string[]) =>
    ({
      call: async (route: string) => {
        calls.push(route);
        return { config, accounts: config.accounts, warnings: [] };
      },
      subscribe: () => () => {},
    }) as unknown as PluginClient;

  it('should read through the reached client of the machine asked for', async () => {
    const calls: string[] = [];
    const factory = wardenClientFactory(async () => answering(calls));
    await (await factory(daemonConnection({ daemonId: 'd2', daemonName: 'desk' }))).config();
    expect(calls).toEqual(['GET /v1/warden/config']);
  });

  it('should read a panel’s one daemon through its own client, whatever it is asked', async () => {
    const calls: string[] = [];
    const factory = homeClientFactory(answering(calls));
    await (await factory(daemonConnection({ daemonId: 'elsewhere', daemonName: 'x' }))).config();
    expect(calls).toEqual(['GET /v1/warden/config']);
  });
});
