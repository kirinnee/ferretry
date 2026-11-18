/**
 * THE BUTTONS THAT ANSWER A REFUSED READ ARE PRESSES (A555 r7, PR 2057). A read the page makes by itself never opens the
 * passkey prompt, and a Cancel stays cancelled — so the button that reads again ("Unlock", "Confirm it's you", "Try
 * again") must send that one read as the person's own (`quiet: false`), or after a Cancel it could never reopen. The page's
 * own reads (its opening, a re-read when a file moved) are never marked.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { createElement } from 'react';
import { ConfigFilesSurface } from '../../../app/config-files/panel.tsx';
import { DoctorSettings } from '../../../app/doctor/doctor-settings.tsx';
import { NameSettings } from '../../../app/name-settings.tsx';
import { recordingClient } from '../../support/app-client.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const refusal = (status: 401 | 403) =>
  Object.assign(new Error('this machine asks you to confirm it is you with a passkey before it shows anything'), {
    status,
    code: status === 401 ? 'unlock_required' : 'grant_step_up_required',
  });

const marked = (calls: readonly { readonly route: string; readonly init?: { readonly quiet?: boolean } }[]) =>
  calls.map(call => `${call.route}${call.init?.quiet === false ? ' (pressed)' : ''}`);

describe('Settings › Name: the Unlock / Confirm it’s you button is a press', () => {
  for (const status of [401, 403] as const) {
    it(`sends the ${String(status)} retry's reads as the person's own, and the opening's reads as the page's`, async () => {
      const { client, calls } = recordingClient(() => refusal(status));
      const view = await mount(createElement(NameSettings, { client }));
      await settle();
      expect(marked(calls).every(call => !call.endsWith('(pressed)'))).toBe(true);
      const before = calls.length;
      const retry = must(view.container.querySelector<HTMLButtonElement>('[data-machine-name-retry]'), 'the press');
      expect(retry.textContent).toBe(status === 401 ? 'Unlock' : 'Confirm it’s you');
      await interact(() => retry.click());
      await settle();
      expect(marked(calls.slice(before))).toContain('GET /v1/config/file (pressed)');
      await view.unmount();
    });
  }
});

describe('Settings › Files and Doctor: Try again is a press', () => {
  it('Files: the opening read is the page’s, the Try again read is pressed', async () => {
    const { client, calls } = recordingClient(() => refusal(401));
    const view = await mount(createElement(ConfigFilesSurface, { client }));
    await settle();
    expect(marked(calls)).toEqual(['GET /v1/config/status']);
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-config-files-retry]'), 'retry').click(),
    );
    await settle();
    expect(marked(calls)).toEqual(['GET /v1/config/status', 'GET /v1/config/status (pressed)']);
    await view.unmount();
  });

  it('Doctor: the opening read is the page’s, the Try again read is pressed', async () => {
    const { client, calls } = recordingClient(() => refusal(401));
    const view = await mount(createElement(DoctorSettings, { client }));
    await settle();
    expect(marked(calls)).toEqual(['GET /v1/doctor']);
    await interact(() => must(view.container.querySelector<HTMLButtonElement>('[data-doctor-retry]'), 'retry').click());
    await settle();
    expect(marked(calls)).toEqual(['GET /v1/doctor', 'GET /v1/doctor (pressed)']);
    await view.unmount();
  });
});
