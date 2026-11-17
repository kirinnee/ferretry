/**
 * "Always use for <project>" under a settled input card: it writes nothing until the owner taps it, writes exactly the
 * body the pure decision builds, says so, and tells the card to keep its view only while it is on offer.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { AlwaysUseLine } from '../../../app/features/accounts/always-use-line.tsx';
import { type Mounted, mount, must } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import { type Call, fakeClient } from '../../support/app/fake-client.ts';
import { list } from '../../support/app/accounts-fixtures.ts';
import { settledSlot } from '../../support/app/input-card-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

interface World {
  readonly put?: (call: Call) => unknown;
  readonly read?: () => unknown;
}

const draw = async (over: Record<string, unknown> = {}, world: World = {}) => {
  const holds: boolean[] = [];
  const fake = fakeClient(call => {
    if (call.route === 'GET /v1/accounts') return world.read?.() ?? list();
    if (call.route === 'PUT /v1/accounts/defaults')
      return world.put?.(call) ?? { defaults: { projects: { 'demo-project': { 'github.com': 'GITHUB' } } } };
    throw new Error(`no answer for ${call.route}`);
  });
  const view = await mount(
    <AlwaysUseLine
      client={fake.client}
      slot={settledSlot({ hold: (holding: boolean) => holds.push(holding), ...over })}
    />,
  );
  mounted.push(view);
  await settle();
  return { view, calls: fake.calls, holds, writes: () => fake.calls.filter(call => call.method === 'PUT') };
};

describe('the "Always use for <project>" line', () => {
  it('draws one quiet button naming the project, and writes nothing until it is tapped', async () => {
    const shown = await draw();
    expect(q(shown.view.container, '[data-input-always-button]').textContent).toBe('Always use for demo-project');
    expect(shown.view.container.textContent).toContain('Makes GitHub the default for github.com in demo-project.');
    // The name is one box, with the full stop that follows it, so a phone never breaks it after its hyphen.
    expect(
      [...shown.view.container.querySelectorAll('[data-input-always-project]')].map(each => each.textContent),
    ).toEqual(['demo-project', 'demo-project.']);
    expect(shown.writes()).toEqual([]);
    // The card keeps its view while the line is on offer.
    expect(shown.holds).toEqual([true]);
  });

  it('writes exactly the body, then says so and lets the card go', async () => {
    const shown = await draw();
    await click(q(shown.view.container, '[data-input-always-button]'));
    await settle();
    expect(shown.writes()).toHaveLength(1);
    expect(shown.writes()[0]?.body).toEqual({
      scope: 'projects',
      within: '0b6f3c1e-2d4a-4c8b-9e1f-7a5d3c2b1a09',
      key: 'github.com',
      account: 'GITHUB',
    });
    expect(q(shown.view.container, '[data-input-always-saved]').textContent).toBe(
      'GitHub is now the default for demo-project at github.com.',
    );
    expect(shown.view.container.querySelector('[data-input-always-button]')).toBeNull();
    expect(shown.holds).toEqual([true, false]);
  });

  it('says a refusal in fixed words, keeps the button for another try, and echoes nothing', async () => {
    const shown = await draw(
      {},
      {
        put: () => {
          throw Object.assign(new Error('internal: GITHUB token abc123'), { status: 500 });
        },
      },
    );
    await click(q(shown.view.container, '[data-input-always-button]'));
    await settle();
    const alert = q(shown.view.container, '[data-input-always-failure]');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('Could not save that default. Nothing changed.');
    expect(shown.view.container.textContent).not.toContain('abc123');
    expect(shown.view.container.querySelector('[data-input-always-button]')).not.toBeNull();
    // Still on offer: the card was never let go.
    expect(shown.holds).toEqual([true]);
  });

  it('lets the card go when it is removed while on offer', async () => {
    const shown = await draw();
    await shown.view.unmount();
    mounted.splice(mounted.indexOf(shown.view), 1);
    expect(shown.holds).toEqual([true, false]);
  });

  it('draws nothing, and holds nothing, for every case the decision refuses', async () => {
    for (const over of [
      { projectDefault: true },
      { project: undefined },
      { signIn: undefined },
      { place: 'evil.example' },
    ]) {
      const shown = await draw(over);
      expect(shown.view.container.innerHTML).toBe('');
      expect(shown.holds).toEqual([]);
      expect(shown.writes()).toEqual([]);
    }
  });

  it('draws nothing when the accounts cannot be read (a device that may not use secrets, a failed read)', async () => {
    const shown = await draw(
      {},
      {
        read: () => {
          throw Object.assign(new Error('no'), { status: 403, code: 'grant_device_withheld' });
        },
      },
    );
    expect(shown.view.container.innerHTML).toBe('');
    expect(shown.holds).toEqual([]);
  });

  it('draws nothing for props the card would never hand over, and reads nothing', async () => {
    const fake = fakeClient(() => list());
    const view = await mount(<AlwaysUseLine client={fake.client} slot={{ ferret: 3 }} />);
    mounted.push(view);
    await settle();
    expect(view.container.innerHTML).toBe('');
    expect(fake.calls).toEqual([]);
  });
});
