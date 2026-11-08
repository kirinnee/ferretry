import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { formatShareFragment } from '../../../../contract/wire/index.ts';
import {
  AddCatalogFromLink,
  JOINING_FROM_A_LINK_UNAVAILABLE,
} from '../../../../app/features/catalogs/add-from-link.tsx';
import { CatalogMoreMenu } from '../../../../app/features/catalogs/catalog-more-menu.tsx';
import { LINK_DAMAGED, LINK_OTHER } from '../../../../app/lib/catalog-link.ts';
import { deviceViewHarness, RouterProvider } from '@ferretry/app/testing';
import { FAKE_CODE } from '../support/catalog-sharing.ts';
import { byText, click, settle, typeInto } from '../support/dom-form.ts';
import { mount } from '@ferretry/app/testing';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const FP = `fy_daemon_${'q'.repeat(43)}`;
const hash = `#${formatShareFragment({ daemonUrl: 'https://box.example.test', daemonId: FP, code: FAKE_CODE } as never)}`;
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

afterEach(() => {
  mock.restore();
});

const paste = async (value: string) => {
  await typeInto(q('[data-catalog-link-input]'), value);
  await click(q('[data-catalog-link-add]'));
  await settle();
};

describe('AddCatalogFromLink', () => {
  it('in a shell, hands the share link to /join in memory: /join is opened with no fragment, nothing in the history', async () => {
    const push = spyOn(window.history, 'pushState');
    const harness = deviceViewHarness({ plugin: 'catalogs', fragments: [], screens: [{ id: 'join', path: '/join' }] });
    const view = await mount(
      <RouterProvider>
        <harness.Harness place="daemon">
          <AddCatalogFromLink />
        </harness.Harness>
      </RouterProvider>,
    );
    await paste(`https://app.example.test/join${hash}`);
    expect(window.location.pathname).toBe('/join');
    expect(window.location.hash).toBe('');
    for (const call of push.mock.calls) expect(String(call[2] ?? '')).not.toContain('#');
    expect(JSON.stringify(window.history.state)).not.toContain('fy_share_');
    expect(document.body.textContent).not.toContain(JOINING_FROM_A_LINK_UNAVAILABLE);
    const join = harness.handOffs.ref<string>('catalogs', 'join');
    expect(join === undefined ? undefined : harness.handOffs.peek(join, 'catalogs')).toBe(hash);
    await view.unmount();
    window.history.replaceState(null, '', '/');
  });

  it('B1 outside a shell refuses a share link with a sentence and never writes its code to the address bar or the history', async () => {
    const push = spyOn(window.history, 'pushState');
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
    const before = window.location.hash;
    const view = await mount(
      <RouterProvider>
        <AddCatalogFromLink />
      </RouterProvider>,
    );
    await paste(`https://app.example.test/join${hash}`);
    expect(document.body.textContent).toContain(JOINING_FROM_A_LINK_UNAVAILABLE);
    expect((q('[data-catalog-link-input]') as HTMLInputElement).value).toBe('');
    expect(window.location.hash).toBe(before);
    expect(window.location.hash).not.toContain('fy_share_');
    expect(window.location.pathname).not.toBe('/join');
    for (const call of push.mock.calls) expect(String(call[2] ?? '')).not.toContain('#');
    expect(assign).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('says plainly what any other link is, and drops the sentence when typing again', async () => {
    const view = await mount(<AddCatalogFromLink />);
    await paste('https://example.com/skills');
    expect(document.body.textContent).toContain(LINK_OTHER);
    await typeInto(q('[data-catalog-link-input]'), 'x');
    expect(document.body.textContent).not.toContain(LINK_OTHER);
    await paste('https://app.example.test/join#v1;url=nope');
    expect(document.body.textContent).toContain(LINK_DAMAGED);
    await view.unmount();
  });
});

describe('CatalogMoreMenu', () => {
  it('opens a menu with Install from a file and runs it', async () => {
    let picked = 0;
    const view = await mount(<CatalogMoreMenu onInstallFromFile={() => picked++} />);
    expect(q('[data-catalog-more]')?.getAttribute('aria-expanded')).toBe('false');
    await click(q('[data-catalog-more]'));
    await settle();
    expect(q('[data-catalog-more]')?.getAttribute('aria-expanded')).toBe('true');
    await click(byText(document, '[role="menuitem"]', 'Install from a file'));
    await settle();
    expect(picked).toBe(1);
    expect(q('[data-catalog-more]')?.getAttribute('aria-expanded')).toBe('false');
    await view.unmount();
  });
});
