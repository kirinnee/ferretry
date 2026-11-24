/** The shared first-run config hook: a pick whose file can no longer be read is dropped, with its registered save. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { WAITING } from '../../../../app/features/onboarding/config-choice.ts';
import { PermissionPage } from '../../../../app/features/onboarding/permission-page.tsx';
import { type Call, scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const WITHHELD_TEXT =
  '# ‹hidden›: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n';
const file = (text: string, etag: string) => ({
  path: 'harness-claude-code.yaml',
  text,
  etag,
  exists: true,
  state: 'ok',
});
const SKIP = 'permissionMode: skip\n';

describe('useConfigChoice: a read that becomes unknown', () => {
  it('after a refused write, a withheld re-read clears the hidden pick and its save; a later readable file is not written', async () => {
    const calls: Call[] = [];
    const reads = [file(SKIP, 'e1'), file(WITHHELD_TEXT, 'e2'), file(SKIP, 'e3')];
    const run = stepHarness();
    const view = await mount(
      <PermissionPage
        client={scripted(
          {
            'GET /v1/config/file': () => reads.shift() ?? file(SKIP, 'e4'),
            'PUT /v1/config/file': () => new Error('The machine refused the write.'),
          },
          calls,
        )}
        step={run.step}
      />,
    );
    mounted.push(view);
    await settle();
    const presses = (): Promise<unknown> =>
      interact(() => run.runCommit()).then(
        () => 'ok',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    const count = (route: string) => calls.filter(call => call.route === route).length;

    await interact(() => must(view.container.querySelector<HTMLInputElement>('input[value="auto"]'), 'auto').click());
    await settle();
    expect(run.hasCommit).toBe(true);
    expect(await presses()).toContain('refused');
    expect(count('PUT /v1/config/file')).toBe(1);

    // The next Next reads the file afresh: it is withheld now, so the page shows the answer as unknown ...
    expect(await presses()).toContain('could not be read');
    await settle();
    expect(view.container.querySelector('[data-mode-unknown]')).not.toBeNull();
    expect(view.container.querySelector('input[type="radio"]')).toBeNull();
    // ... and the hidden pick's save is gone, so another Next neither reads nor writes: nothing hidden can be saved.
    expect(run.hasCommit).toBe(false);
    expect(await presses()).toBe('ok');
    expect(count('GET /v1/config/file')).toBe(2);
    expect(count('PUT /v1/config/file')).toBe(1);
  });
});

describe('useConfigChoice: a file with a change held for the owner', () => {
  it('shows the waiting line in place of the cards and writes nothing: the held edit cannot ride the one-key save', async () => {
    const calls: Call[] = [];
    const run = stepHarness();
    const held = { ...file('binary: /held/by/an/agent\npermissionMode: auto\n', 'e1'), state: 'pending' };
    const view = await mount(
      <PermissionPage
        client={scripted(
          { 'GET /v1/config/file': held, 'PUT /v1/config/file': { path: 'x', etag: 'e2', outcome: 'applied' } },
          calls,
        )}
        step={run.step}
      />,
    );
    mounted.push(view);
    await settle();
    expect(view.container.querySelector('[data-config-waiting]')?.textContent).toBe(WAITING);
    expect(view.container.querySelector('input[type="radio"]')).toBeNull();
    // The held text says auto, but the cards (and so the "saved" mode) are not drawn from it.
    expect(view.container.querySelector('[data-permission-consequence]')).toBeNull();
    // Next re-reads the file (still held here: the footer says so and nothing is written).
    expect(run.hasCommit).toBe(true);
    await expect(interact(() => run.runCommit())).rejects.toThrow('waiting for your OK');
    expect(calls.map(call => call.route)).toEqual(['GET /v1/config/file', 'GET /v1/config/file']);
  });

  it('recovers after the owner confirms the held edit: Next re-reads, the cards appear, and the pick then writes exactly once', async () => {
    const calls: Call[] = [];
    const run = stepHarness();
    const reads = [{ ...file('permissionMode: auto\n', 'e1'), state: 'pending' }, file('permissionMode: auto\n', 'e2')];
    const view = await mount(
      <PermissionPage
        client={scripted(
          {
            'GET /v1/config/file': () => reads.shift() ?? file('permissionMode: auto\n', 'e2'),
            'PUT /v1/config/file': { path: 'harness-claude-code.yaml', etag: 'e3', outcome: 'applied' },
          },
          calls,
        )}
        step={run.step}
      />,
    );
    mounted.push(view);
    await settle();
    expect(view.container.querySelector('[data-config-waiting]')).not.toBeNull();
    const count = (route: string) => calls.filter(call => call.route === route).length;

    // The owner confirms elsewhere; Next re-reads instead of going on over the stale waiting screen.
    await expect(interact(() => run.runCommit())).rejects.toThrow('settled');
    await settle();
    expect(count('GET /v1/config/file')).toBe(2);
    expect(count('PUT /v1/config/file')).toBe(0);
    expect(view.container.querySelector('[data-config-waiting]')).toBeNull();
    expect(view.container.querySelectorAll('input[type="radio"]').length).toBe(2);

    // Now there is something to pick: one pick, one Next, exactly one PUT.
    await interact(() => must(view.container.querySelector<HTMLInputElement>('input[value="skip"]'), 'skip').click());
    await settle();
    await interact(() => run.runCommit());
    expect(count('PUT /v1/config/file')).toBe(1);
  });
});
