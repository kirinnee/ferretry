import { describe, expect, it } from 'bun:test';

import { LocationChip, type LocationDraft, PendingLocationChip } from '../../src/components/location-chip.tsx';
import { DevicePermissionsContext } from '../../src/hooks/use-device-permissions.ts';
import { LocationError, type LocationFix } from '../../src/lib/location-share.ts';
import { interact, mount, must } from '../support/dom.ts';

const fix = (overrides: Partial<LocationFix> = {}): LocationFix => ({
  latitude: 51.50735,
  longitude: -0.12776,
  accuracyMeters: 20,
  capturedAt: Date.parse('2026-10-21T12:00:00.000Z'),
  ...overrides,
});

describe('LocationChip', () => {
  it('shows the pair, the accuracy and the capture time of a shared location', async () => {
    const view = await mount(<LocationChip fix={fix()} />);
    const chip = must(view.container.querySelector<HTMLElement>('[data-location-chip]'), 'the chip');
    expect(chip.textContent).toContain('Shared location');
    expect(chip.textContent).toContain('51.50735, -0.12776');
    expect(chip.textContent).toContain('About 20 m');
    expect(chip.title).toBe('2026-10-21T12:00:00.000Z');
    await view.unmount();
  });

  it('uses the place name as the title when there is one', async () => {
    const view = await mount(<LocationChip fix={fix({ place: 'Home' })} />);
    expect(view.container.textContent).toContain('Home');
    expect(view.container.textContent).not.toContain('Shared location');
    await view.unmount();
  });
});

const pending = (draft: LocationDraft, disabled?: boolean) => {
  const calls = { place: [] as string[], removed: 0, retried: 0 };
  const element = (
    <PendingLocationChip
      draft={draft}
      {...(disabled === undefined ? {} : { disabled })}
      onPlace={place => calls.place.push(place)}
      onRemove={() => {
        calls.removed += 1;
      }}
      onRetry={() => {
        calls.retried += 1;
      }}
    />
  );
  return { calls, element };
};

describe('PendingLocationChip', () => {
  it('announces that it is finding the location, and can be cancelled', async () => {
    const { calls, element } = pending({ kind: 'locating' });
    const view = await mount(element);
    expect(view.container.querySelector('[data-location-draft="locating"]')?.textContent).toContain(
      'Finding your location',
    );
    await interact(() => must(view.container.querySelector<HTMLButtonElement>('button'), 'remove').click());
    expect(calls.removed).toBe(1);
    await view.unmount();
  });

  it('shows the reading, says it is sent once, and lets the reader name the place', async () => {
    const { calls, element } = pending({ kind: 'ready', fix: fix({ place: 'Home' }) });
    const view = await mount(element);
    const chip = must(view.container.querySelector<HTMLElement>('[data-location-draft="ready"]'), 'the chip');
    expect(chip.textContent).toContain('Sharing your location');
    expect(chip.textContent).toContain('sent once, with this message');
    const input = must(chip.querySelector<HTMLInputElement>('input'), 'the place field');
    expect(input.value).toBe('Home');
    expect(input.maxLength).toBe(80);

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await interact(() => {
      setValue?.call(input, 'Office');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(calls.place).toEqual(['Office']);

    await interact(() =>
      must(chip.querySelector<HTMLButtonElement>('button[aria-label="Remove the shared location"]'), 'remove').click(),
    );
    expect(calls.removed).toBe(1);
    await view.unmount();
  });

  it('starts with an empty place field when no name was given', async () => {
    const view = await mount(pending({ kind: 'ready', fix: fix() }).element);
    expect(must(view.container.querySelector<HTMLInputElement>('input'), 'the field').value).toBe('');
    await view.unmount();
  });

  it('disables its controls while the message is sending', async () => {
    const view = await mount(pending({ kind: 'ready', fix: fix() }, true).element);
    for (const control of view.container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
      expect(control.disabled).toBe(true);
    }
    await view.unmount();
  });

  it('on a refusal, says how to turn location back on for this device, and offers another try', async () => {
    const { calls, element } = pending({
      kind: 'failed',
      error: new LocationError('denied', 'Location is turned off for Ferretry on this device.'),
    });
    const view = await mount(element);
    const chip = must(view.container.querySelector<HTMLElement>('[data-location-draft="failed"]'), 'the failure');
    expect(chip.getAttribute('role')).toBe('alert');
    expect(chip.textContent).toContain('Location is turned off');
    expect(chip.querySelector('ol')?.textContent).toContain('Site settings');

    const retry = must(
      [...chip.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Try again')),
      'try again',
    );
    await interact(() => retry.click());
    expect(calls.retried).toBe(1);
    await view.unmount();
  });

  it('on a timeout, offers another try but no settings steps', async () => {
    const view = await mount(pending({ kind: 'failed', error: new LocationError('timeout', 'slow') }).element);
    expect(view.container.querySelector('ol')).toBeNull();
    expect(view.container.textContent).toContain('Try again');
    await view.unmount();
  });

  it('on an unsupported browser, offers nothing to retry', async () => {
    const view = await mount(pending({ kind: 'failed', error: new LocationError('unsupported', 'no') }).element);
    expect(view.container.textContent).not.toContain('Try again');
    await view.unmount();
  });

  it('uses the device’s own steps when a permissions host knows the device', async () => {
    const host = {
      facts: { family: 'ios', installed: true, secure: true } as const,
      status: async () => 'prompt' as const,
      request: async () => 'prompt' as const,
    };
    const view = await mount(
      <DevicePermissionsContext.Provider value={host}>
        {pending({ kind: 'failed', error: new LocationError('denied', 'off') }).element}
      </DevicePermissionsContext.Provider>,
    );
    expect(view.container.querySelector('ol')?.textContent).toContain('find Ferretry in the list of apps');
    await view.unmount();
  });
});
