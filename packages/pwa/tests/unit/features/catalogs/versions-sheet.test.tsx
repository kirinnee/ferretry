import { beforeEach, describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { VersionsSheet } from '../../../../src/features/catalogs/versions-sheet.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { memberView } from '../../../support/catalog-sharing.ts';
import { catalogChanges, CATALOG, ITEM, ownedCatalog, sharedItem } from '../../../support/catalog-views.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';

beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const NOW = Date.parse('2026-11-02T09:00:00.000Z');
const AT = '2026-10-31T09:00:00.000Z';
const ITEM_PATH = `/v1/catalog-items/${ITEM}`;

const threeVersions = (current = 3, retired: number[] = []) =>
  sharedItem({
    current,
    versions: [1, 2, 3].map(version => ({
      version,
      size: 100 * version,
      publishedAt: AT,
      summary: `v${String(version)}`,
      fileCount: version,
      ...(retired.includes(version) ? { retiredAt: AT } : {}),
      usedBy: { catalogIds: version === current ? [CATALOG] : [] },
    })),
  });

type Handlers = Parameters<typeof fakeClient>[0];
const base = (item = threeVersions()): Handlers => ({
  [`GET ${ITEM_PATH}`]: () => item,
  'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }),
  'GET /v1/catalog-members': () => ({ members: [memberView()] }),
});

async function open(handlers: Handlers, canWrite = true, closed: string[] = [], changed: string[] = []) {
  const fake = fakeClient(handlers);
  const view = await mount(
    <VersionsSheet
      connection={connection}
      itemId={ITEM}
      label="pdf-tools"
      canWrite={canWrite}
      nowMs={NOW}
      createClient={fake.factory}
      onClose={() => closed.push('closed')}
      onChanged={() => changed.push('changed')}
    />,
  );
  await settle();
  return { fake, view };
}

const lineOf = (version: number): HTMLElement | null => q(`[data-version="${String(version)}"]`);
const tap = async (selector: string) => {
  await click(q(selector));
  await settle();
};

describe('VersionsSheet list', () => {
  it('lists every version newest first with the age, files and size, who uses it and who can see it', async () => {
    const { view } = await open(base());
    expect([...document.querySelectorAll('[data-version]')].map(node => node.getAttribute('data-version'))).toEqual([
      '3',
      '2',
      '1',
    ]);
    expect(q('[data-version="3"][data-version-current]')).not.toBeNull();
    expect(lineOf(3)?.querySelector('[data-version-text]')?.textContent).toBe(
      'v3 · current · 2 days ago · 3 files · 300 B',
    );
    expect(q('[data-versions-reach]')?.textContent).toContain('Used by Team skills.');
    expect(q('[data-versions-reach]')?.textContent).toContain('1 person can see it.');
    await view.unmount();
  });

  it('marks a retired version and offers to bring it back, not to make it current', async () => {
    const { view } = await open(base(threeVersions(3, [2])));
    expect(lineOf(2)?.hasAttribute('data-version-retired')).toBe(true);
    expect(lineOf(2)?.textContent).toContain('retired');
    expect(q('[data-version-unretire="2"]')).not.toBeNull();
    expect(q('[data-version-make-current="2"]')).toBeNull();
    await view.unmount();
  });

  it('is for reading only without versions.2', async () => {
    const { view } = await open(base(), false);
    expect(q('[data-version-make-current]')).toBeNull();
    expect(q('[data-version-retire]')).toBeNull();
    expect(q('[data-version-unretire]')).toBeNull();
    expect(q('[data-version-changes="3"]')).not.toBeNull();
    await view.unmount();
  });

  it('says nothing about reach when the members cannot be read, and names a catalog that is gone', async () => {
    const { view } = await open({
      ...base(),
      'GET /v1/catalogs': () => ({ catalogs: [] }),
      'GET /v1/catalog-members': () => {
        throw new FyHttpError('no', 500, 'x');
      },
    });
    expect(q('[data-versions-reach]')?.textContent).toContain('A catalog that is gone');
    expect(q('[data-versions-reach]')?.textContent).not.toContain('can see it');
    await view.unmount();
  });

  it('shows a failure to read with Try again, and says Sharing is off', async () => {
    let broken = true;
    const { view } = await open({
      ...base(),
      [`GET ${ITEM_PATH}`]: () => {
        if (broken) throw new FyHttpError('boom', 500, 'x');
        return threeVersions();
      },
    });
    expect(q('[data-catalog-failure]')).not.toBeNull();
    broken = false;
    await tap('[data-catalog-preview-again]');
    expect(q('[data-versions-list]')).not.toBeNull();
    await view.unmount();
    const off = await open({
      ...base(),
      [`GET ${ITEM_PATH}`]: () => {
        throw new FyHttpError('no', 403, 'grant_device_not_granted');
      },
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    await off.view.unmount();
  });
});

describe('What changed', () => {
  it('reads the changes between neighbours and hides them again', async () => {
    const { fake, view } = await open({
      ...base(),
      [`GET ${ITEM_PATH}/changes?from=2&to=3`]: () => catalogChanges(),
    });
    expect(q('[data-version-changes="1"]')).toBeNull();
    await tap('[data-version-changes="3"]');
    expect(fake.calls.at(-1)?.path).toBe(`${ITEM_PATH}/changes?from=2&to=3`);
    expect(lineOf(3)?.querySelector('[data-changes-view]')?.getAttribute('aria-label')).toBe('What changed: v2 to v3');
    expect(lineOf(3)?.querySelector('[data-change-flag="command"]')).not.toBeNull();
    await tap('[data-version-changes="3"]');
    expect(q('[data-changes-view]')).toBeNull();
    await view.unmount();
  });

  it('says when the comparison could not be read', async () => {
    const { view } = await open({
      ...base(),
      [`GET ${ITEM_PATH}/changes?from=2&to=3`]: () => {
        throw new FyHttpError('nope', 500, 'x');
      },
    });
    await tap('[data-version-changes="3"]');
    expect(lineOf(3)?.querySelector('[data-catalog-failure]')).not.toBeNull();
    await view.unmount();
  });

  it('ignores an answer for a comparison that was closed meanwhile', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const { view } = await open({
      ...base(),
      [`GET ${ITEM_PATH}/changes?from=2&to=3`]: async () => {
        await held;
        return catalogChanges();
      },
    });
    await click(q('[data-version-changes="3"]'));
    expect(lineOf(3)?.textContent).toContain('Comparing');
    await click(q('[data-version-changes="3"]'));
    release?.();
    await settle();
    expect(q('[data-changes-view]')).toBeNull();
    await view.unmount();
  });

  it('ignores a failure for a comparison that was closed meanwhile', async () => {
    let fail: (() => void) | undefined;
    const held = new Promise<void>((_resolve, reject) => {
      fail = () => reject(new FyHttpError('nope', 500, 'x'));
    });
    const { view } = await open({
      ...base(),
      [`GET ${ITEM_PATH}/changes?from=2&to=3`]: async () => {
        await held;
        return catalogChanges();
      },
    });
    await click(q('[data-version-changes="3"]'));
    await click(q('[data-version-changes="3"]'));
    fail?.();
    await settle();
    expect(q('[data-catalog-failure]')).toBeNull();
    await view.unmount();
  });
});

describe('make current, retire, bring back', () => {
  it('makes a version current with `from`, says so and tells the list behind', async () => {
    let item = threeVersions(3);
    const changed: string[] = [];
    const { fake, view } = await open(
      {
        ...base(),
        [`GET ${ITEM_PATH}`]: () => item,
        [`PUT ${ITEM_PATH}/current`]: () => {
          item = threeVersions(2);
          return { itemId: ITEM, itemVersion: 2, current: 2, catalogs: [], item };
        },
      },
      true,
      [],
      changed,
    );
    await tap('[data-version-make-current="2"]');
    expect(q('[data-version-confirm="current"]')?.textContent).toContain(
      'Every catalog that lists it will offer version 2',
    );
    await tap('[data-version-confirm-yes]');
    expect(fake.calls.find(call => call.method === 'PUT')?.body).toEqual({ version: 2, from: 3 });
    expect(q('[data-versions-note]')?.textContent).toBe('Version 2 is current now.');
    expect(q('[data-version="2"][data-version-current]')).not.toBeNull();
    expect(changed).toEqual(['changed']);
    await view.unmount();
  });

  it('backs out of a question with Not now', async () => {
    const { fake, view } = await open(base());
    await tap('[data-version-retire="2"]');
    expect(q('[data-version-confirm="retire"]')?.textContent).toContain('Version 2 will stop being offered');
    await tap('[data-version-confirm-no]');
    expect(q('[data-version-confirm]')).toBeNull();
    expect(fake.calls.some(call => call.method === 'PATCH')).toBe(false);
    await view.unmount();
  });

  it('retires a version, then brings it back', async () => {
    let item = threeVersions(3);
    const { fake, view } = await open({
      ...base(),
      [`GET ${ITEM_PATH}`]: () => item,
      [`PATCH ${ITEM_PATH}/versions/2`]: body => {
        const retired = (body as { retired: boolean }).retired;
        item = threeVersions(3, retired ? [2] : []);
        return { itemId: ITEM, version: 2, changed: true, catalogs: [], ...(retired ? { retiredAt: AT } : {}) };
      },
    });
    await tap('[data-version-retire="2"]');
    await tap('[data-version-confirm-yes]');
    expect(fake.calls.find(call => call.method === 'PATCH')?.body).toEqual({ retired: true });
    expect(q('[data-versions-note]')?.textContent).toBe('Version 2 is retired.');
    expect(lineOf(2)?.hasAttribute('data-version-retired')).toBe(true);
    await tap('[data-version-unretire="2"]');
    expect(q('[data-version-confirm="unretire"]')?.textContent).toContain('can be offered again');
    await tap('[data-version-confirm-yes]');
    expect(fake.calls.filter(call => call.method === 'PATCH').at(-1)?.body).toEqual({ retired: false });
    expect(q('[data-versions-note]')?.textContent).toBe('Version 2 is back in use.');
    await view.unmount();
  });

  it('names the catalogs that joined later when the version is from before they joined', async () => {
    const sentence =
      'Version 1 of pdf-tools is not one Friends may serve: a catalog serves an item from the version it was added at, and never the versions that already existed then.';
    const { view } = await open({
      ...base(),
      [`PUT ${ITEM_PATH}/current`]: () => {
        throw new FyHttpError(sentence, 409, 'version_before_join');
      },
    });
    await tap('[data-version-make-current="1"]');
    await tap('[data-version-confirm-yes]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Friends may serve');
    expect(q('[data-version-confirm]')).not.toBeNull();
    await view.unmount();
  });

  it('says to make another version current first when the daemon refuses to retire the current one', async () => {
    const { view } = await open({
      ...base(),
      [`PATCH ${ITEM_PATH}/versions/2`]: () => {
        throw new FyHttpError('current', 409, 'version_current');
      },
    });
    await tap('[data-version-retire="2"]');
    await tap('[data-version-confirm-yes]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Make another version current first.');
    await view.unmount();
  });

  it('reads again and says so when the current version moved on meanwhile', async () => {
    let item = threeVersions(3);
    const { view } = await open({
      ...base(),
      [`GET ${ITEM_PATH}`]: () => item,
      [`PUT ${ITEM_PATH}/current`]: () => {
        item = threeVersions(1);
        throw new FyHttpError('moved', 409, 'current_changed');
      },
    });
    await tap('[data-version-make-current="2"]');
    await tap('[data-version-confirm-yes]');
    expect(q('[data-versions-note]')?.textContent).toContain('The current version changed since you opened this.');
    expect(q('[data-version-confirm]')).toBeNull();
    expect(q('[data-version="1"][data-version-current]')).not.toBeNull();
    await view.unmount();
  });

  it('says Sharing is off when a write is refused for that reason', async () => {
    const { view } = await open({
      ...base(),
      [`PATCH ${ITEM_PATH}/versions/2`]: () => {
        throw new FyHttpError('no', 403, 'grant_device_not_granted');
      },
    });
    await tap('[data-version-retire="2"]');
    await tap('[data-version-confirm-yes]');
    expect(q('[data-sharing-off]')).not.toBeNull();
    await view.unmount();
  });
});
