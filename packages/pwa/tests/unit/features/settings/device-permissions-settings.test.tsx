import { describe, expect, it } from 'bun:test';

import { DevicePermissionsSetting } from '../../../../src/features/settings/device-permissions-settings.tsx';
import {
  DevicePermissionsContext,
  FALLBACK_DEVICE_FACTS,
  useDeviceFacts,
  useDevicePermissions,
} from '../../../../src/hooks/use-device-permissions.ts';
import type {
  DeviceFacts,
  DevicePermissionId,
  DevicePermissionState,
  DevicePermissionsHost,
} from '../../../../src/lib/device-permissions.ts';
import { interact, mount, must } from '../../../support/dom.ts';

type States = Partial<Record<DevicePermissionId, DevicePermissionState>>;

const ALL_PROMPT: States = {
  camera: 'prompt',
  microphone: 'prompt',
  notifications: 'prompt',
  location: 'prompt',
  'clipboard-read': 'prompt',
  'persistent-storage': 'prompt',
};

const fakeHost = (states: States, answers: States = {}, facts?: DeviceFacts) => {
  const requested: DevicePermissionId[] = [];
  const reads: DevicePermissionId[] = [];
  const current = { ...states };
  const host: DevicePermissionsHost = {
    facts: facts ?? FALLBACK_DEVICE_FACTS,
    status: async id => {
      reads.push(id);
      return current[id] ?? 'unsupported';
    },
    request: id => {
      requested.push(id);
      const answer = answers[id] ?? 'granted';
      current[id] = answer;
      return Promise.resolve(answer);
    },
  };
  return { host, requested, reads, current };
};

const within = (host: DevicePermissionsHost | null) => (
  <DevicePermissionsContext.Provider value={host}>
    <DevicePermissionsSetting />
  </DevicePermissionsContext.Provider>
);

const row = (container: HTMLElement, id: DevicePermissionId): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-permission="${id}"]`), `the ${id} row`);

describe('DevicePermissionsSetting', () => {
  it('says so, plainly, when the page has no way to read permissions', async () => {
    const view = await mount(within(null));
    expect(view.container.textContent).toContain('without a way to read device permissions');
    await view.unmount();
  });

  it('lists every permission with its state, and asks for nothing on load', async () => {
    const { host, requested, reads } = fakeHost({
      ...ALL_PROMPT,
      camera: 'granted',
      microphone: 'denied',
      location: 'unsupported',
    });
    const view = await mount(within(host));

    expect(view.container.querySelectorAll('[data-permission]')).toHaveLength(6);
    expect(row(view.container, 'camera').dataset.state).toBe('granted');
    expect(row(view.container, 'camera').textContent).toContain('Allowed');
    expect(row(view.container, 'microphone').dataset.state).toBe('denied');
    expect(row(view.container, 'microphone').textContent).toContain('Blocked');
    expect(row(view.container, 'location').textContent).toContain('Unavailable');
    expect(row(view.container, 'notifications').textContent).toContain('Not asked yet');
    expect(row(view.container, 'camera').textContent).toContain('Scans the QR code');
    expect(requested).toEqual([]);
    expect(reads.sort()).toEqual(Object.keys(ALL_PROMPT).sort() as typeof reads);
    await view.unmount();
  });

  it('explains why a permission is unavailable, with no button', async () => {
    const { host } = fakeHost({ ...ALL_PROMPT, location: 'unsupported' });
    const view = await mount(within(host));

    const location = row(view.container, 'location');
    expect(location.querySelector('[role="note"]')?.textContent).toContain('This browser does not offer this.');
    expect(location.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('asks only when its own button is pressed, and then shows the answer', async () => {
    const { host, requested } = fakeHost(ALL_PROMPT, { camera: 'granted' });
    const view = await mount(within(host));

    const button = must(
      view.container.querySelector<HTMLButtonElement>('[data-permission-request="camera"]'),
      'the camera button',
    );
    expect(button.textContent).toBe('Allow camera');
    await interact(() => button.click());

    expect(requested).toEqual(['camera']);
    expect(row(view.container, 'camera').dataset.state).toBe('granted');
    expect(view.container.querySelector('[data-permission-request="camera"]')).toBeNull();
    await view.unmount();
  });

  it('starts the browser call inside the click itself', async () => {
    const { host, requested } = fakeHost(ALL_PROMPT);
    const view = await mount(within(host));
    const button = must(
      view.container.querySelector<HTMLButtonElement>('[data-permission-request="location"]'),
      'the location button',
    );

    button.click();
    expect(requested).toEqual(['location']);
    await interact(async () => {});
    await view.unmount();
  });

  it('offers a refused permission as steps for this kind of device, hidden until asked for', async () => {
    const { host } = fakeHost(
      { ...ALL_PROMPT, camera: 'denied' },
      {},
      { family: 'ios', installed: false, secure: true },
    );
    const view = await mount(within(host));

    const toggle = must(
      view.container.querySelector<HTMLButtonElement>('[data-permission-howto="camera"]'),
      'the how-to button',
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(row(view.container, 'camera').querySelector('ol')).toBeNull();
    expect(row(view.container, 'camera').querySelector('[data-permission-request]')).toBeNull();

    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(row(view.container, 'camera').querySelector('ol')?.textContent).toContain('Safari');

    await interact(() => toggle.click());
    expect(row(view.container, 'camera').querySelector('ol')).toBeNull();
    await view.unmount();
  });

  it('re-reads when the reader returns to the page, picking up a change made in system Settings', async () => {
    const { host, current } = fakeHost({ ...ALL_PROMPT, camera: 'denied' });
    const view = await mount(within(host));
    expect(row(view.container, 'camera').dataset.state).toBe('denied');

    current.camera = 'granted';
    await interact(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(row(view.container, 'camera').dataset.state).toBe('granted');

    current.camera = 'prompt';
    await interact(() => document.dispatchEvent(new Event('focus')));
    expect(row(view.container, 'camera').dataset.state).toBe('prompt');
    await view.unmount();
  });

  it('shows "Checking…" until a read arrives, and ignores an answer that lands after unmount', async () => {
    let release: (state: DevicePermissionState) => void = () => {};
    const late = new Promise<DevicePermissionState>(resolve => {
      release = resolve;
    });
    const host: DevicePermissionsHost = {
      facts: FALLBACK_DEVICE_FACTS,
      status: () => late,
      request: () => late,
    };
    const view = await mount(within(host));
    expect(row(view.container, 'camera').textContent).toContain('Checking…');
    expect(row(view.container, 'camera').dataset.state).toBe('checking');

    await view.unmount();
    release('granted');
    await late;
  });
});

describe('device permission hooks', () => {
  it('falls back to a plain desktop tab when no host is provided, and uses the host’s facts otherwise', async () => {
    let seen: DeviceFacts | undefined;
    const Probe = () => {
      seen = useDeviceFacts();
      return null;
    };
    const bare = await mount(<Probe />);
    expect(seen).toBe(FALLBACK_DEVICE_FACTS);
    await bare.unmount();

    const facts: DeviceFacts = { family: 'ios', installed: true, secure: true };
    const { host } = fakeHost({}, {}, facts);
    const provided = await mount(
      <DevicePermissionsContext.Provider value={host}>
        <Probe />
      </DevicePermissionsContext.Provider>,
    );
    expect(seen).toBe(facts);
    await provided.unmount();
  });

  it('gives no controller without a host', async () => {
    let controller: ReturnType<typeof useDevicePermissions> | undefined;
    const Probe = () => {
      controller = useDevicePermissions();
      return null;
    };
    const view = await mount(<Probe />);
    expect(controller).toBeNull();
    await view.unmount();
  });

  it('refresh() re-reads on demand', async () => {
    const { host, reads } = fakeHost({ camera: 'prompt' });
    let controller: ReturnType<typeof useDevicePermissions> | undefined;
    const Probe = () => {
      controller = useDevicePermissions(null);
      return null;
    };
    const view = await mount(
      <DevicePermissionsContext.Provider value={host}>
        <Probe />
      </DevicePermissionsContext.Provider>,
    );
    const before = reads.length;
    await interact(() => controller?.refresh());
    expect(reads.length).toBe(before * 2);
    await view.unmount();
  });
});
