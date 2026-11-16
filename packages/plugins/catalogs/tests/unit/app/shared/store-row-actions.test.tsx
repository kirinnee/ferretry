import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { Attempt, UpdateSource } from '../../../../app/features/shared/shared-controller.ts';
import { InstalledControls } from '../../../../app/features/shared/store-row-actions.tsx';
import { fakeClient } from '../support/catalog-client.ts';
import { catalogChanges, INSTALL_ID, installRecord } from '../support/catalog-views.ts';
import { click, settle } from '../support/dom-form.ts';
import { mount } from '@ferretry/app/testing';
import {
  deferred,
  failedAttempt,
  installedAtV1,
  machinePreview,
  okAttempt,
  refusedAttempt,
  type UpdateFixture,
  updateFixture,
} from '../support/shared-screens.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const acts = (): string[] =>
  all('[data-shared-item-act]').map(button => button.getAttribute('data-shared-item-act') ?? '');

let fx: UpdateFixture;
beforeAll(async () => {
  fx = await updateFixture();
});

const PATCH = `PATCH /v1/catalog-installs/runtime/${INSTALL_ID}`;
const PREVIEW = 'POST /v1/catalog-installs/runtime/preview';
const APPLY = 'POST /v1/catalog-installs/runtime';

const sourceAt = (version: 1 | 2): UpdateSource => ({
  item: version === 1 ? fx.v1 : fx.v2,
  manifest: fx.opened.manifest,
  signedManifest: fx.view.signed as never,
  ...(version === 1 ? { signedVersions: fx.signedVersions } : {}),
  expectedDigest: fx.signedVersions.versions.offered.find(line => line.version === version)?.digest ?? '',
});

async function open(
  handlers: Parameters<typeof fakeClient>[0],
  options: {
    change?: Record<string, unknown>;
    entry?: UpdateFixture['entry'];
    versions?: () => Promise<Attempt<UpdateFixture['signedVersions']>>;
  } = {},
) {
  const fake = fakeClient(handlers);
  const changed: string[] = [];
  const refused: string[] = [];
  const asked: number[] = [];
  const view = await mount(
    <InstalledControls
      members={{
        versions: options.versions ?? (async () => okAttempt(fx.signedVersions)),
        openVersion: async (_sub, _view, _entry, version) => {
          asked.push(version);
          return okAttempt(sourceAt(version === 1 ? 1 : 2));
        },
      }}
      sub={{} as never}
      view={fx.view}
      entry={options.entry ?? fx.entry}
      installed={installedAtV1(fx, options.change)}
      installHost={{ createClient: fake.factory }}
      onRefused={() => refused.push('refused')}
      onChanged={() => changed.push('changed')}
    />,
  );
  await settle();
  return { ...fake, view, changed, refused, asked };
}

const MENU_ACTS = new Set(['stay', 'skip', 'move']);

/** A button beside the status, or an item of the More menu (opened first). */
const tap = async (act: string) => {
  if (MENU_ACTS.has(act)) {
    await click(q('[data-shared-item-more]'));
    await click(q(`[data-menu-key="${act}"]`));
  } else await click(q(`[data-shared-item-act="${act}"]`));
  await settle();
  await settle();
};

describe('what the row says', () => {
  it('says only Installed for a current install, and offers nothing', async () => {
    const { view } = await open({}, { entry: { ...fx.entry, version: 1 } });
    expect(q('[data-shared-item-installed]')?.textContent).toBe('v1 installed');
    expect(q('[data-shared-item-status]')?.getAttribute('data-shared-item-status')).toBe('current');
    expect(acts()).toEqual([]);
    expect(q('[data-shared-item-more]')).toBeNull();
    await view.unmount();
  });

  it('says both versions in the chip, with Update and See changes and one More beside it, each at least 44 px high', async () => {
    const { view } = await open({});
    expect(q('[data-shared-item-installed]')?.textContent).toBe('v1 installed · v2 available');
    expect(acts()).toEqual(['update', 'changes']);
    expect(all('[data-shared-item-act]').map(button => button.textContent)).toEqual(['Update', 'See changes']);
    const more = q('[data-shared-item-more]');
    expect(more?.getAttribute('aria-label')).toBe('More');
    expect(more?.getAttribute('aria-haspopup')).toBe('menu');
    expect(
      [...all('[data-shared-item-act]'), more].every(button => button?.className.includes('min-h-[44px]') === true),
    ).toBe(true);
    await view.unmount();
  });

  it('keeps Stay, Skip and Move in the More menu, each saying what it does', async () => {
    const { view } = await open({});
    expect(q('[role="menu"]')).toBeNull();
    await click(q('[data-shared-item-more]'));
    expect(q('[data-shared-item-more]')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('[role="menu"]')?.getAttribute('aria-label')).toBe('More for pdf-tools');
    expect(all('[role="menuitem"]').map(item => item.getAttribute('data-menu-key'))).toEqual(['stay', 'skip', 'move']);
    expect(all('[role="menuitem"]').map(item => item.textContent)).toEqual([
      'Stay on v1Keep v1 and stop asking about newer versions. Ask again clears it.',
      'Skip this versionHide v2 only. A newer version asks again.',
      'Move to version…Pick any version the publisher still offers, newer or older.',
    ]);
    q('[aria-label="Close menu"]')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(q('[role="menu"]')).toBeNull();
    await view.unmount();
  });

  it('offers only a move, in the menu, when the publisher took the newer version back', async () => {
    const { view } = await open({}, { entry: { ...fx.entry, version: 0 } });
    expect(q('[data-shared-item-installed]')?.textContent).toBe('v1 installed');
    expect(acts()).toEqual([]);
    await click(q('[data-shared-item-more]'));
    expect(all('[role="menuitem"]').map(item => item.getAttribute('data-menu-key'))).toEqual(['move']);
    await view.unmount();
  });
});

describe('stay, skip and ask again', () => {
  it('writes Stay on the machine that holds the install and reads the records again', async () => {
    const { view, calls, changed } = await open({ [PATCH]: () => installRecord() });
    await tap('stay');
    expect(calls).toEqual([
      { method: 'PATCH', path: `/v1/catalog-installs/runtime/${INSTALL_ID}`, body: { hold: true } },
    ]);
    expect(changed).toEqual(['changed']);
    await view.unmount();
  });

  it('writes Skip for the version now listed', async () => {
    const { view, calls } = await open({ [PATCH]: () => installRecord() });
    await tap('skip');
    expect(calls[0]?.body).toEqual({ skippedVersion: 2 });
    await view.unmount();
  });

  it('asks again by clearing the stay choice, or the skip', async () => {
    const stayed = await open({ [PATCH]: () => installRecord() }, { change: { hold: true } });
    expect(q('[data-shared-item-installed]')?.textContent).toBe('v1 installed · Staying on v1');
    await tap('again');
    expect(stayed.calls[0]?.body).toEqual({ hold: false });
    await stayed.view.unmount();
    document.body.replaceChildren();
    const skipped = await open({ [PATCH]: () => installRecord() }, { change: { skippedVersion: 2 } });
    expect(q('[data-shared-item-installed]')?.textContent).toBe('v1 installed · Skipped v2');
    await tap('again');
    expect(skipped.calls[0]?.body).toEqual({ skippedVersion: null });
    await skipped.view.unmount();
  });

  it('says the choice was not saved when the machine refuses, and does not read the records again', async () => {
    const { view, changed } = await open({
      [PATCH]: () => {
        throw new DaemonCallError(409, 'catalog_install_conflict', 'no');
      },
    });
    await tap('stay');
    expect(q('[data-catalog-failure]')).not.toBeNull();
    expect(changed).toEqual([]);
    await view.unmount();
  });
});

describe('see changes and update', () => {
  const handlers = () => ({
    [PREVIEW]: () => machinePreview(fx, 2, { changes: catalogChanges() }),
    [APPLY]: () => ({ install: installRecord('skill', 'pdf-tools'), notes: [] }),
  });

  it('opens the diff the machine computed, and closes it with nothing changed', async () => {
    const { view, asked, changed } = await open(handlers());
    await tap('changes');
    expect(q('[data-update-changes]')).not.toBeNull();
    expect(asked).toEqual([2]);
    await click(q('[aria-label="Close pdf-tools"]'));
    expect(q('[data-update-changes]')).toBeNull();
    expect(changed).toEqual([]);
    await view.unmount();
  });

  it('opens the review with the passkey button, and reads the records again once it landed', async () => {
    const { view, changed } = await open(handlers());
    await tap('update');
    await click(q('[data-catalog-install]'));
    await settle();
    await settle();
    expect(q('[data-catalog-installed]')).not.toBeNull();
    await click(q('[data-catalog-done]'));
    expect(changed).toEqual(['changed']);
    expect(q('[data-catalog-installed]')).toBeNull();
    await view.unmount();
  });
});

describe('move to version', () => {
  const handlers = () => ({
    [PREVIEW]: () => machinePreview(fx, 1, { changes: catalogChanges() }),
  });

  it('lists every version on offer, newest first, and blocks the installed one', async () => {
    const { view } = await open(handlers());
    await tap('move');
    const lines = all('[data-move-version]');
    expect(lines.map(line => line.getAttribute('data-move-direction'))).toEqual(['newer', 'installed']);
    expect(lines[0]?.textContent).toContain('v2 · Newer · Current · 2026-10-31');
    expect((lines[1] as HTMLButtonElement).disabled).toBe(true);
    expect(lines.every(line => line.className.includes('min-h-[44px]'))).toBe(true);
    const installed = lines[1] as HTMLElement;
    expect(installed.querySelector('[data-move-installed-mark]')).not.toBeNull();
    expect(installed.textContent).toContain('Installed');
    expect(installed.getAttribute('aria-current')).toBe('true');
    expect(installed.className).toContain('disabled:opacity-100');
    expect(lines[0]?.querySelector('[data-move-installed-mark]')).toBeNull();
    await view.unmount();
  });

  it('says it is reading while the list has not come', async () => {
    const gate = deferred<Attempt<UpdateFixture['signedVersions']>>();
    const { view } = await open(handlers(), { versions: async () => await gate.promise });
    await tap('move');
    expect(q('[data-move-loading]')).not.toBeNull();
    gate.resolve(okAttempt(fx.signedVersions));
    await settle();
    expect(q('[data-move-loading]')).toBeNull();
    await view.unmount();
  });

  it('opens the move sheet for a version picked, with the list that offered it', async () => {
    const { view, asked } = await open({
      [PREVIEW]: () => machinePreview(fx, 2, { changes: catalogChanges() }),
    });
    await tap('move');
    await click(q('[data-move-version="2"]'));
    await settle();
    await settle();
    expect(q('[data-move-version]')).toBeNull();
    expect(asked).toEqual([2]);
    expect(q('[data-catalog-install]')).not.toBeNull();
    await view.unmount();
  });

  it('says there is nothing else on offer when only the installed version is', async () => {
    const only = {
      ...fx.signedVersions,
      versions: { ...fx.signedVersions.versions, offered: [fx.signedVersions.versions.offered[0]] },
    };
    const { view } = await open(handlers(), { versions: async () => okAttempt(only as never) });
    await tap('move');
    expect(q('[data-move-none]')).not.toBeNull();
    expect(q('[data-move-version]')).toBeNull();
    await view.unmount();
  });

  it('says why the list could not be used, and hands back to the page when the key was refused', async () => {
    const failed = await open(handlers(), { versions: async () => failedAttempt('gone', 'Not the list.') });
    await tap('move');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Not the list.');
    await failed.view.unmount();
    document.body.replaceChildren();
    const refused = await open(handlers(), { versions: async () => refusedAttempt() });
    await tap('move');
    expect(refused.refused).toEqual(['refused']);
    await refused.view.unmount();
  });

  it('closes the list with nothing changed', async () => {
    const { view } = await open(handlers());
    await tap('move');
    await click(q('[aria-label="Close Move to version…"]'));
    expect(q('[data-move-version]')).toBeNull();
    await view.unmount();
  });
});
