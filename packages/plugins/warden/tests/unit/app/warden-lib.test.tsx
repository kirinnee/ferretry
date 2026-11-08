import { describe, expect, it } from 'bun:test';
import { mount } from '@ferretry/app/testing';
import { FormField } from '../../../app/lib/form-parts.tsx';
import { ferretTitles } from '../../../app/lib/callsign.ts';
import { wardenClientOf } from '../../../app/lib/warden-client.ts';
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
