import { afterEach, describe, expect, it } from 'bun:test';

import { DaemonSettingsFrame } from '../../../../src/features/settings/daemon-settings-frame.tsx';
import { FleetEnvironmentSettings } from '../../../../src/features/settings/fleet-environment-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const selectValue = async (select: HTMLSelectElement, value: string): Promise<void> => {
  const setter = must(Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set, 'select setter');
  await interact(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('FleetEnvironmentSettings', () => {
  it('mounts the environment panel from the daemon settings frame', () => {
    globalThis.fetch = (async () => response({ profiles: { portable: {} } })) as unknown as typeof fetch;
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        connections={[alpha]}
        name="Alpha"
        readWardenStatus={async () => Promise.reject(new Error('unavailable'))}
        createWardenClient={async () => Promise.reject(new Error('unavailable'))}
      />,
    );

    const environment = must(
      view.root
        .findAllByProps({ role: 'tab' })
        .find(tab => tab.props['aria-controls'] === 'daemon-settings-tab-environment'),
      'environment tab',
    );
    run(() => environment.props.onClick());

    // The open panel names itself through the tab that selected it rather than
    // repeating that tab's text, so the two can never disagree.
    expect(view.root.findByProps({ id: 'daemon-settings-tab-environment' }).props['aria-labelledby']).toBe(
      'daemon-panel-tab-environment',
    );
    expect(view.root.findByProps({ id: 'daemon-panel-tab-environment' }).props.role).toBe('tab');
    run(() => view.unmount());
  });

  it('keeps Host checks explicitly unavailable without the browser pairing record', () => {
    const view = render(<DaemonSettingsFrame connection={alpha} connections={[alpha]} name="Alpha" />);
    const hostChecks = must(
      view.root
        .findAllByProps({ role: 'tab' })
        .find(tab => tab.props['aria-controls'] === 'daemon-settings-tab-host-checks'),
      'host checks tab',
    );

    run(() => hostChecks.props.onClick());

    expect(
      view.root
        .findByProps({ 'aria-label': 'Host checks unavailable' })
        .findAllByType('p')
        .flatMap(paragraph => paragraph.children)
        .join(''),
    ).toContain('browser pairing record was not supplied');
    run(() => view.unmount());
  });

  it('explains the device read-only authority and points at the Fleet tab with no write affordance', async () => {
    const calls: Array<{ readonly url: URL; readonly init?: RequestInit }> = [];
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init });
      return response({ profiles: { portable: { VISIBLE: 'yes' } } });
    }) as typeof fetch;

    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[alpha]} />);
    await settle();

    const text = view.container.textContent ?? '';
    expect(text).toContain('read-only');
    expect(text).toContain('Fleet tab');
    expect(text).toContain('approve it on the host');
    // No write affordance remains: no editor, no apply control, and never a write request.
    expect(view.container.querySelector('textarea')).toBeNull();
    expect([...view.container.querySelectorAll('button')].some(button => /apply/i.test(button.textContent ?? ''))).toBe(
      false,
    );
    expect(calls.some(call => call.init?.method === 'PUT')).toBe(false);
    expect(calls.some(call => call.init?.method === 'POST')).toBe(false);

    await view.unmount();
  });

  it('compares the target profile against a chosen daemon and shows every difference kind without writing', async () => {
    const calls: Array<{ readonly url: URL; readonly init?: RequestInit }> = [];
    const target = { profiles: { portable: { KEEP: 'same', CHANGE: 'old', ONLY_HERE: 'target' }, other: {} } };
    const source = { profiles: { portable: { KEEP: 'same', CHANGE: 'new', ONLY_THERE: 'source' }, other: {} } };
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return response(url.host === 'beta.example.test' ? source : target);
    }) as typeof fetch;

    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[alpha, beta]} />);
    await settle();
    const selects = view.container.querySelectorAll<HTMLSelectElement>('select');
    await selectValue(must(selects[0], 'compare-with selector'), 'beta');
    await settle();

    const text = view.container.textContent ?? '';
    expect(text).toContain('ONLY_HERE');
    expect(text).toContain('target only');
    expect(text).toContain('ONLY_THERE');
    expect(text).toContain('source only');
    expect(text).toContain('CHANGE');
    expect(text).toContain('differs');
    // The identical entry is inspected on the target, not reported as a difference.
    expect(text).toContain('KEEP');
    expect(text).toContain('same');

    // The comparison read is keyed to the chosen daemon's own address, never crossed with the target.
    expect(calls.some(call => call.url.host === 'beta.example.test')).toBe(true);
    // No write request is ever issued from inspection.
    expect(calls.some(call => call.init?.method === 'PUT')).toBe(false);

    await view.unmount();
  });

  it('switches profile to update the inspected entries and reports an empty profile honestly', async () => {
    globalThis.fetch = (async (input: URL | RequestInfo) =>
      response(
        new URL(String(input)).host === 'beta.example.test'
          ? { profiles: { portable: { SAME: 'value' }, other: {} } }
          : { profiles: { portable: { SAME: 'value' }, other: {} } },
      )) as typeof fetch;

    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[alpha, beta]} />);
    await settle();
    const selects = view.container.querySelectorAll<HTMLSelectElement>('select');
    // The default comparison is the daemon with itself: nothing differs.
    expect(view.container.textContent).toContain('No differences');

    await selectValue(must(selects[1], 'profile selector'), 'other');
    expect(view.container.textContent).toContain('This profile publishes no environment entries.');

    await selectValue(must(selects[1], 'profile selector'), 'portable');
    expect(view.container.textContent).toContain('SAME');
    expect(view.container.textContent).toContain('value');

    await view.unmount();
  });

  it('reports honestly when the daemon publishes no fleet profiles', async () => {
    globalThis.fetch = (async () => response({ profiles: {} })) as unknown as typeof fetch;
    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[alpha]} />);
    await settle();

    expect(view.container.textContent).toContain('This daemon publishes no fleet profiles.');
    await view.unmount();
  });

  it('shows a readable error when the environment cannot be read', async () => {
    globalThis.fetch = (async () => new Response('not JSON', { status: 503 })) as unknown as typeof fetch;
    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[]} />);
    await settle();

    expect(must(view.container.querySelector('[role="alert"]'), 'read error').textContent).toContain(
      'Read failed (503)',
    );
    expect(view.container.querySelector('[aria-label="Target environment entries"]')).toBeNull();
    await view.unmount();
  });
});
