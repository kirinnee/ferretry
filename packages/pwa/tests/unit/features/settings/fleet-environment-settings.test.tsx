import { afterEach, describe, expect, it } from 'bun:test';

import { FleetEnvironmentSettings } from '../../../../src/features/settings/fleet-environment-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';

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

const writeText = async (textarea: HTMLTextAreaElement, value: string): Promise<void> => {
  const setter = must(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set, 'textarea setter');
  await interact(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('FleetEnvironmentSettings', () => {
  it('previews a source profile, changes copy semantics, and applies an edited safe environment', async () => {
    const calls: Array<{ readonly url: URL; readonly init?: RequestInit }> = [];
    const target = { profiles: { portable: { KEEP: 'target', CHANGE: 'old', REMOVE: 'gone' }, other: {} } };
    const source = { profiles: { portable: { CHANGE: 'new', ADD: 'value' }, other: { OTHER: 'source' } } };
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (init?.method === 'PUT') return response({ profiles: {} });
      return response(url.host === 'beta.example.test' ? source : target);
    }) as typeof fetch;

    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[alpha, beta]} />);
    await settle();
    const selects = view.container.querySelectorAll<HTMLSelectElement>('select');
    await selectValue(must(selects[0], 'source daemon selector'), 'beta');
    await settle();

    expect(view.container.textContent).toContain('Target diff (2 changes)');
    expect(view.container.textContent).toContain('added ADD: — → value');
    expect(view.container.textContent).toContain('changed CHANGE: old → new');

    await interact(() =>
      must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Replace target')),
        'replace button',
      ).click(),
    );
    expect(view.container.textContent).toContain('Target diff (4 changes)');
    expect(view.container.textContent).toContain('removed REMOVE: gone → —');

    await selectValue(must(selects[1], 'profile selector'), 'other');
    expect(must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'environment editor').value).toContain(
      'OTHER',
    );
    await writeText(
      must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'environment editor'),
      '{"EDITED":"yes","NUMBER":2}',
    );
    expect(view.container.textContent).toContain('Target diff (1 changes)');

    await writeText(
      must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'environment editor'),
      '{"EDITED":"yes"}',
    );
    const apply = must(
      [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Apply replace')),
      'apply button',
    );
    expect(apply.disabled).toBe(false);
    await interact(() => apply.click());
    await settle();

    const put = must(
      calls.find(call => call.init?.method === 'PUT'),
      'environment copy request',
    );
    expect(put.url.pathname).toBe('/v1/fleet/environment');
    expect(JSON.parse(String(put.init?.body))).toEqual({
      profile: 'other',
      mode: 'replace',
      environment: { EDITED: 'yes' },
    });
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await view.unmount();
  });

  it('disables invalid drafts and reports a daemon refusal without changing the target', async () => {
    globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'PUT') return response({ error: 'fleet_environment_refused' }, 403);
      return response({ profiles: { portable: { OLD: 'value' } } });
    }) as typeof fetch;
    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[alpha]} />);
    await settle();

    const editor = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'environment editor');
    await writeText(editor, 'not JSON');
    expect(
      must(
        [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Apply merge')),
        'apply button',
      ).disabled,
    ).toBe(true);

    await writeText(editor, '{"NEW":"value"}');
    const apply = must(
      [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Apply merge')),
      'apply button',
    );
    await interact(() => apply.click());
    await settle();

    expect(must(view.container.querySelector('[role="alert"]'), 'refusal').textContent).toContain(
      'fleet_environment_refused',
    );
    await view.unmount();
  });

  it('shows a readable error when the source cannot be read', async () => {
    globalThis.fetch = (async () => new Response('not JSON', { status: 503 })) as unknown as typeof fetch;
    const view = await mount(<FleetEnvironmentSettings connection={alpha} connections={[]} />);
    await settle();

    expect(must(view.container.querySelector('[role="alert"]'), 'read error').textContent).toContain(
      'Read failed (503)',
    );
    expect(view.container.querySelector('[aria-label="Configuration diff"]')).toBeNull();
    await view.unmount();
  });
});
