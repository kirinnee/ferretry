import { describe, expect, it } from 'bun:test';
import { formatShareFragment } from '@ferretry/protocol';
import { AddCatalogFromLink } from '../../../../src/features/catalogs/add-from-link.tsx';
import { CatalogMoreMenu } from '../../../../src/features/catalogs/catalog-more-menu.tsx';
import { LINK_DAMAGED, LINK_OTHER } from '../../../../src/lib/catalog-link.ts';
import { RouterProvider } from '../../../../src/lib/router.tsx';
import { FAKE_CODE } from '../../../support/catalog-sharing.ts';
import { byText, click, settle, typeInto } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';

const FP = `fy_daemon_${'q'.repeat(43)}`;
const hash = `#${formatShareFragment({ daemonUrl: 'https://box.example.test', daemonId: FP, code: FAKE_CODE } as never)}`;
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const paste = async (value: string) => {
  await typeInto(q('[data-catalog-link-input]'), value);
  await click(q('[data-catalog-link-add]'));
  await settle();
};

describe('AddCatalogFromLink', () => {
  it('hands a share link to the join page and clears the field', async () => {
    const joined: string[] = [];
    const view = await mount(<AddCatalogFromLink onJoin={fragment => joined.push(fragment)} />);
    await paste(`https://app.example.test/join${hash}`);
    expect(joined).toEqual([hash]);
    expect((q('[data-catalog-link-input]') as HTMLInputElement).value).toBe('');
    expect(q('[role="alert"]')).toBeNull();
    await view.unmount();
  });

  it('opens /join with the fragment through the router', async () => {
    const view = await mount(
      <RouterProvider>
        <AddCatalogFromLink />
      </RouterProvider>,
    );
    await paste(`https://app.example.test/join${hash}`);
    expect(window.location.pathname).toBe('/join');
    expect(window.location.hash).toBe(hash);
    window.history.replaceState({}, '', '/');
    await view.unmount();
  });

  it('says plainly what any other link is, and drops the sentence when typing again', async () => {
    const joined: string[] = [];
    const view = await mount(<AddCatalogFromLink onJoin={fragment => joined.push(fragment)} />);
    await paste('https://example.com/skills');
    expect(document.body.textContent).toContain(LINK_OTHER);
    await typeInto(q('[data-catalog-link-input]'), 'x');
    expect(document.body.textContent).not.toContain(LINK_OTHER);
    await paste('https://app.example.test/join#v1;url=nope');
    expect(document.body.textContent).toContain(LINK_DAMAGED);
    expect(joined).toEqual([]);
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
