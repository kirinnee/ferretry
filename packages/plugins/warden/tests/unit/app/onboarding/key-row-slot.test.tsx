/**
 * Where the Warden's first-run page draws the Jev key: only Voice's `speedup-key` panel, for the subject `jev`, from the
 * `settings` slot; no other plugin's panel there is drawn, and with no panel placed nothing is.
 */
import { mount, WithSlotPanels } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { JevKeyRow } from '../../../../app/features/onboarding/key-row-slot.tsx';

const mounted: Awaited<ReturnType<typeof mount>>[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

describe('JevKeyRow', () => {
  it('draws Voice\'s speedup-key panel with the subject "jev", and nothing else placed in the slot', async () => {
    const seen: unknown[] = [];
    const view = await mount(
      <WithSlotPanels
        slots={{
          settings: [
            {
              plugin: 'voice',
              id: 'speedup-key',
              view: props => {
                seen.push(props.subject);
                return <span data-fake="voice-key" />;
              },
            },
            { plugin: 'logins', id: 'add-login', view: () => <span data-fake="logins" /> },
          ],
        }}
      >
        <JevKeyRow daemon="this" />
      </WithSlotPanels>,
    );
    mounted.push(view);
    expect(view.container.querySelector('[data-fake="voice-key"]')).not.toBeNull();
    expect(view.container.querySelector('[data-fake="logins"]')).toBeNull();
    expect(seen.every(subject => subject === 'jev')).toBe(true);
  });

  it('draws nothing where Voice places no panel', async () => {
    const view = await mount(
      <WithSlotPanels slots={{ settings: [] }}>
        <JevKeyRow daemon="this" />
      </WithSlotPanels>,
    );
    mounted.push(view);
    expect(view.container.textContent).toBe('');
  });
});
