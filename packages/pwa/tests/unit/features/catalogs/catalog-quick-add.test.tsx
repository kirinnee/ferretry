import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { CatalogItemRow, type CatalogItemRowProps } from '../../../../src/features/catalogs/catalog-item-row.tsx';
import { type CatalogRowsHost, useCatalogRows } from '../../../../src/features/catalogs/catalog-row-tools.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { memberView } from '../../../support/catalog-sharing.ts';
import {
  addedAnswer,
  CATALOG,
  ITEM,
  itemPreview,
  ownedCatalog,
  sharedItem,
  TOKEN,
} from '../../../support/catalog-views.ts';
import { byText, click, settle } from '../../../support/dom-form.ts';
import { healthOf } from '../../../support/health.ts';
import { interact, mount } from '../../../support/dom.ts';
import { installManualClock, type ManualClock } from '../../../support/manual-clock.ts';

beforeEach(() => {
  document.body.replaceChildren();
});

let clock: ManualClock | null = null;
afterEach(() => {
  clock?.restore();
  clock = null;
});

const SKILL = '/home/k/.claude/skills/pdf-tools/SKILL.md';
const SECOND = `cat_${'d'.repeat(22)}` as const;
const source = { kind: 'skill', skill: SKILL } as const;
const scope = { label: 'User', title: 'A skill of yours', tone: 'muted' } as const;
const NAMED = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'token-a',
  daemonName: 'kirin-box',
});
const UNNAMED = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const QUICK = '/v1/catalog-items/quick-add';
const UNDO = '/v1/catalog-items/quick-add/undo';
const BOTH = ['catalogs.items.1', 'catalogs.quick-add.1'];

function Row({
  host,
  overrides,
}: {
  readonly host: CatalogRowsHost;
  readonly overrides?: Partial<CatalogItemRowProps>;
}) {
  const read = useCatalogRows(host);
  return (
    <CatalogItemRow
      host={host}
      read={read}
      kind="skill"
      itemName="pdf-tools"
      label="/pdf-tools"
      source={source}
      scope={scope}
      {...overrides}
    />
  );
}

interface Setup {
  readonly catalogs?: ReturnType<typeof ownedCatalog>[];
  readonly defaultCatalogId?: string;
  readonly features?: string[] | null;
  readonly connection?: typeof NAMED;
  readonly more?: Parameters<typeof fakeClient>[0];
}

async function show(setup: Setup = {}) {
  const catalogs = setup.catalogs ?? [ownedCatalog({ role: 'default' })];
  const fake = fakeClient({
    'GET /v1/catalog-installs': () => ({ installs: [] }),
    'GET /v1/catalogs': () => ({
      catalogs,
      ...(setup.defaultCatalogId === undefined ? {} : { defaultCatalogId: setup.defaultCatalogId }),
    }),
    'GET /v1/catalog-members': () => ({ members: [memberView()] }),
    'GET /v1/health': () => {
      if (setup.features === null) throw new Error('offline');
      return healthOf('1.0.0', setup.features ?? BOTH);
    },
    ...setup.more,
  });
  const host = { connection: setup.connection ?? NAMED, createClient: fake.factory };
  const view = await mount(<Row host={host} />);
  await settle();
  return { fake, view };
}

/** Lets promise chains finish without a timer, which a manual clock would never fire. */
const flush = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};
const advance = async (milliseconds: number): Promise<void> => {
  await interact(() => clock?.advance(milliseconds));
  await flush();
};
const tapAdd = async (): Promise<void> => {
  await click(q('[data-row-add]'));
  await (clock === null ? settle() : flush());
};
const callsTo = (fake: Awaited<ReturnType<typeof show>>['fake'], path: string) =>
  fake.calls.filter(call => call.path === path);
const toastText = (): string => q('[data-catalog-toast]')?.textContent ?? '';
const pickMenu = async (label: string): Promise<void> => {
  await click(q('[data-row-more]'));
  await click(byText(document, '[role="menuitem"]', label));
  await settle();
};

const added = { 'POST /v1/catalog-items/quick-add': () => addedAnswer() };
const retracted = { catalogId: CATALOG, itemId: ITEM, mode: 'retracted', revision: 5, itemRemoved: false };

describe('the Add button says where it goes', () => {
  it('names the default catalog, or the one it will make from the machine name', async () => {
    const withDefault = await show();
    expect(q('[data-row-add]')?.getAttribute('aria-label')).toBe('Add /pdf-tools to Team skills');
    await withDefault.view.unmount();
    const none = await show({ catalogs: [] });
    expect(q('[data-row-add]')?.getAttribute('aria-label')).toBe('Add /pdf-tools (makes kirin-box’s skills)');
    await none.view.unmount();
    const anonymous = await show({ catalogs: [], connection: UNNAMED });
    expect(q('[data-row-add]')?.getAttribute('aria-label')).toBe('Add /pdf-tools (makes My skills)');
    await anonymous.view.unmount();
  });

  it('finds the default by the id the list names', async () => {
    const { view } = await show({ catalogs: [ownedCatalog()], defaultCatalogId: CATALOG });
    expect(q('[data-row-add]')?.getAttribute('aria-label')).toBe('Add /pdf-tools to Team skills');
    await view.unmount();
  });

  it('opens today’s sheet when the machine has no one-tap Add, or cannot be asked', async () => {
    for (const features of [['catalogs.items.1'], [], null]) {
      const { view } = await show({ features });
      expect(q('[data-row-add]')?.getAttribute('aria-label')).toBe('Add /pdf-tools to a catalog');
      await click(q('[data-row-add]'));
      await settle();
      expect(q('[data-catalog-sheet="add"]')).not.toBeNull();
      expect(q('[data-catalog-notice]')).toBeNull();
      await view.unmount();
      document.body.replaceChildren();
    }
  });
});

describe('one tap', () => {
  it('adds, says where, and offers Undo for ten seconds', async () => {
    const { fake, view } = await show({ more: added });
    clock = installManualClock();
    await tapAdd();
    expect(callsTo(fake, QUICK)[0]?.body).toEqual({ source });
    expect(toastText()).toContain('Added to Team skills');
    expect(q('[data-catalog-toast-undo]')?.getAttribute('aria-label')).toBe('Undo: Added to Team skills');
    expect(q('[data-catalog-toast-count]')?.textContent).toBe('10s');
    expect(q('[data-catalog-sheet="add"]')).toBeNull();
    await advance(4000);
    expect(q('[data-catalog-toast-count]')?.textContent).toBe('6s');
    await advance(6000);
    expect(q('[data-catalog-toast]')).toBeNull();
    await view.unmount();
  });

  it('sends one request for a double tap', async () => {
    let release: (() => void) | undefined;
    const { fake, view } = await show({
      more: {
        'POST /v1/catalog-items/quick-add': async () => {
          await new Promise<void>(resolve => (release = resolve));
          return addedAnswer();
        },
      },
    });
    const button = q('[data-row-add]');
    await click(button);
    await click(button);
    await settle();
    expect((q('[data-row-add]') as HTMLButtonElement).disabled).toBe(true);
    release?.();
    await settle();
    expect(callsTo(fake, QUICK)).toHaveLength(1);
    expect((q('[data-row-add]') as HTMLButtonElement).disabled).toBe(false);
    await view.unmount();
  });

  it('says it is already there, naming the catalog, or "your default catalog" for one it cannot name', async () => {
    const known = await show({
      more: {
        'POST /v1/catalog-items/quick-add': () => ({
          outcome: 'already',
          catalogId: CATALOG,
          itemId: ITEM,
          itemVersion: 2,
        }),
      },
    });
    await tapAdd();
    expect(toastText()).toBe('Already in Team skills');
    expect(q('[data-catalog-toast-undo]')).toBeNull();
    await known.view.unmount();
    document.body.replaceChildren();
    const unknown = await show({
      more: {
        'POST /v1/catalog-items/quick-add': () => ({
          outcome: 'already',
          catalogId: SECOND,
          itemId: ITEM,
          itemVersion: 2,
        }),
      },
    });
    await tapAdd();
    expect(toastText()).toBe('Already in your default catalog');
    await unknown.view.unmount();
  });

  it('drops the "already" note after four seconds', async () => {
    const { view } = await show({
      more: {
        'POST /v1/catalog-items/quick-add': () => ({
          outcome: 'already',
          catalogId: CATALOG,
          itemId: ITEM,
          itemVersion: 2,
        }),
      },
    });
    clock = installManualClock();
    await tapAdd();
    await advance(3900);
    expect(q('[data-catalog-toast]')).not.toBeNull();
    await advance(200);
    expect(q('[data-catalog-toast]')).toBeNull();
    await view.unmount();
  });

  it('opens the review with the default selected when the tap must stop for a person', async () => {
    const { catalogId: _drop, ...preview } = itemPreview({
      warnings: [{ code: 'carries-scripts', text: 'It carries a script.' }],
    });
    const { fake, view } = await show({
      catalogs: [ownedCatalog({ id: SECOND, name: 'Other' }), ownedCatalog({ role: 'default' })],
      more: {
        'POST /v1/catalog-items/quick-add': () => ({ outcome: 'review', reasons: ['warnings'], preview }),
        [`POST /v1/catalogs/${CATALOG}/items`]: () => ({
          catalogId: CATALOG,
          itemId: ITEM,
          itemVersion: 3,
          digest: preview.digest,
          revision: 6,
          item: ownedCatalog().items[0],
        }),
      },
    });
    await tapAdd();
    expect(q('[data-catalog-notice]')?.textContent).toBe('It has something to read first.');
    expect(q('[data-catalog-preview-block]')?.textContent).toContain('It carries a script.');
    expect((q('[data-catalog-picker]') as HTMLSelectElement).value).toBe(CATALOG);
    await click(q('[data-catalog-add]'));
    expect(callsTo(fake, `/v1/catalogs/${CATALOG}/items`)[0]?.body).toEqual({ source, digest: preview.digest });
    expect(q('[data-catalog-landed]')?.textContent).toContain('Saved to Team skills');
    await view.unmount();
  });

  it('keeps the review when the person picks another catalog', async () => {
    const { catalogId: _drop, ...preview } = itemPreview();
    const { view } = await show({
      catalogs: [ownedCatalog({ role: 'default' }), ownedCatalog({ id: SECOND, name: 'Other' })],
      more: { 'POST /v1/catalog-items/quick-add': () => ({ outcome: 'review', reasons: ['problems'], preview }) },
    });
    await tapAdd();
    const picker = q('[data-catalog-picker]') as HTMLSelectElement;
    await interact(() => {
      picker.value = SECOND;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q('[data-catalog-preview-block]')).not.toBeNull();
    expect(q('[data-catalog-notice]')).toBeNull();
    await view.unmount();
  });

  it('offers a new catalog named for the machine when there is no default, and makes it the default', async () => {
    const { catalogId: _drop, ...preview } = itemPreview();
    const made = ownedCatalog({ name: 'kirin-box’s skills', items: [] });
    const { fake, view } = await show({
      catalogs: [],
      more: {
        'POST /v1/catalog-items/quick-add': () => ({ outcome: 'review', reasons: ['needs-summary'], preview }),
        'POST /v1/catalogs': () => made,
        [`PATCH /v1/catalogs/${CATALOG}`]: () => ownedCatalog({ role: 'default' }),
        [`POST /v1/catalogs/${CATALOG}/items`]: () => ({
          catalogId: CATALOG,
          itemId: ITEM,
          itemVersion: 1,
          digest: preview.digest,
          revision: 1,
          item: ownedCatalog().items[0],
        }),
      },
    });
    await tapAdd();
    expect((q('[data-catalog-new-name]') as HTMLInputElement).value).toBe('kirin-box’s skills');
    expect(q('[data-catalog-notice]')?.textContent).toContain('one-line summary');
    await click(q('[data-catalog-add]'));
    expect(callsTo(fake, '/v1/catalogs').filter(call => call.method === 'POST')[0]?.body).toEqual({
      name: 'kirin-box’s skills',
    });
    expect(callsTo(fake, `/v1/catalogs/${CATALOG}`).find(call => call.method === 'PATCH')?.body).toEqual({
      role: 'default',
    });
    expect(q('[data-catalog-landed]')).not.toBeNull();
    await view.unmount();
  });

  it('still lands the item when making the new catalog the default fails', async () => {
    const { catalogId: _drop, ...preview } = itemPreview();
    const { view } = await show({
      catalogs: [],
      more: {
        'POST /v1/catalog-items/quick-add': () => ({ outcome: 'review', reasons: ['warnings'], preview }),
        'POST /v1/catalogs': () => ownedCatalog({ items: [] }),
        [`PATCH /v1/catalogs/${CATALOG}`]: () => {
          throw new FyHttpError('no', 500, 'internal');
        },
        [`POST /v1/catalogs/${CATALOG}/items`]: () => ({
          catalogId: CATALOG,
          itemId: ITEM,
          itemVersion: 1,
          digest: preview.digest,
          revision: 1,
          item: ownedCatalog().items[0],
        }),
      },
    });
    await tapAdd();
    await click(q('[data-catalog-add]'));
    expect(q('[data-catalog-landed]')).not.toBeNull();
    await view.unmount();
  });

  it('opens the plain sheet with the sentence when the review has nothing to show yet', async () => {
    const { view } = await show({
      more: { 'POST /v1/catalog-items/quick-add': () => ({ outcome: 'review', reasons: ['warnings'] }) },
    });
    await tapAdd();
    expect(q('[data-catalog-notice]')?.textContent).toBe('It has something to read first.');
    expect(q('[data-catalog-preview-block]')).toBeNull();
    await view.unmount();
  });

  it('opens the sheet with the daemon’s sentence on any refusal, including more than one source', async () => {
    for (const [code, text] of [
      ['source_ambiguous', 'Pick a catalog'],
      ['catalogs_full', '256'],
    ] as const) {
      const { view } = await show({
        more: {
          'POST /v1/catalog-items/quick-add': () => {
            throw new FyHttpError('refused', 409, code);
          },
        },
      });
      await tapAdd();
      expect(q('[data-catalog-notice]')?.textContent).toContain(text);
      expect(q('[data-catalog-toast]')).toBeNull();
      await view.unmount();
      document.body.replaceChildren();
    }
  });
});

describe('Undo', () => {
  it('takes the add back and says it left no trace', async () => {
    const { fake, view } = await show({ more: { ...added, [`POST ${UNDO}`]: () => retracted } });
    await tapAdd();
    await click(q('[data-catalog-toast-undo]'));
    await settle();
    expect(callsTo(fake, UNDO)[0]?.body).toEqual({ token: TOKEN });
    expect(toastText()).toBe('Taken back. It was never in Team skills for anyone.');
    expect(q('[data-catalog-toast-undo]')).toBeNull();
    await view.unmount();
  });

  it('says a withdrawal shows as withdrawn', async () => {
    const { view } = await show({ more: { ...added, [`POST ${UNDO}`]: () => ({ ...retracted, mode: 'withdrawn' }) } });
    await tapAdd();
    await click(q('[data-catalog-toast-undo]'));
    await settle();
    expect(toastText()).toContain('Withdrawn from Team skills.');
    await view.unmount();
  });

  it('says when Undo ran out of time', async () => {
    const { view } = await show({
      more: {
        ...added,
        [`POST ${UNDO}`]: () => {
          throw new FyHttpError('late', 409, 'undo_expired');
        },
      },
    });
    await tapAdd();
    await click(q('[data-catalog-toast-undo]'));
    await settle();
    expect(toastText()).toContain('Undo ran out of time');
    await view.unmount();
  });

  it('turns Undo off while it is working', async () => {
    let release: (() => void) | undefined;
    const { view } = await show({
      more: {
        ...added,
        [`POST ${UNDO}`]: async () => {
          await new Promise<void>(resolve => (release = resolve));
          return retracted;
        },
      },
    });
    await tapAdd();
    await click(q('[data-catalog-toast-undo]'));
    expect((q('[data-catalog-toast-undo]') as HTMLButtonElement).disabled).toBe(true);
    release?.();
    await settle();
    expect(toastText()).toContain('Taken back');
    await view.unmount();
  });
});

describe('Add to another catalog…', () => {
  const second = ownedCatalog({ id: SECOND, name: 'Other', items: [] });
  const existingHandlers = (item = sharedItem()) => ({
    'GET /v1/catalog-items': () => ({ publisher: `fy_daemon_${'q3Xk'.repeat(10)}Xkq`, items: [item] }),
  });
  const preview = itemPreview({ catalogId: SECOND, version: 2 });
  const landed = {
    catalogId: SECOND,
    itemId: ITEM,
    itemVersion: 2,
    digest: preview.digest,
    revision: 2,
    item: ownedCatalog().items[0],
  };

  it('reviews the frozen version, leaves out catalogs that already list it, and adds that version', async () => {
    const { fake, view } = await show({
      catalogs: [ownedCatalog({ role: 'default' }), second],
      more: {
        ...existingHandlers(),
        [`POST /v1/catalogs/${SECOND}/items/preview`]: () => preview,
        [`POST /v1/catalogs/${SECOND}/items`]: () => landed,
      },
    });
    await pickMenu('Add to another catalog…');
    expect(q('[data-catalog-sheet="add"]')?.textContent).toContain('Add to another catalog');
    const picker = q('[data-catalog-picker]') as HTMLSelectElement;
    expect([...picker.options].map(option => option.value)).toEqual([SECOND, '__new']);
    expect(callsTo(fake, `/v1/catalogs/${SECOND}/items/preview`)[0]?.body).toEqual({ itemId: ITEM });
    expect(q('[data-catalog-preview-block]')?.textContent).toContain('version 2');
    await click(q('[data-catalog-add]'));
    expect(callsTo(fake, `/v1/catalogs/${SECOND}/items`)[0]?.body).toEqual({ itemId: ITEM, version: 2 });
    expect(q('[data-catalog-landed]')?.textContent).toContain('Saved to Other');
    await view.unmount();
  });

  it('shows what the item is now, with a sentence, when it moved on since it was read', async () => {
    let adds = 0;
    const { view } = await show({
      catalogs: [ownedCatalog({ role: 'default' }), second],
      more: {
        ...existingHandlers(),
        [`POST /v1/catalogs/${SECOND}/items/preview`]: () => ({ ...preview, version: 3 }),
        [`POST /v1/catalogs/${SECOND}/items`]: () => {
          adds += 1;
          throw new FyHttpError('moved', 409, 'current_changed');
        },
      },
    });
    await pickMenu('Add to another catalog…');
    await click(q('[data-catalog-add]'));
    expect(adds).toBe(1);
    expect(q('[data-catalog-notice]')?.textContent).toBeTruthy();
    expect(q('[data-catalog-preview-block]')?.textContent).toContain('version 3');
    await view.unmount();
  });

  it('says so when the re-read fails too', async () => {
    let previews = 0;
    const { view } = await show({
      catalogs: [ownedCatalog({ role: 'default' }), second],
      more: {
        ...existingHandlers(),
        [`POST /v1/catalogs/${SECOND}/items/preview`]: () => {
          previews += 1;
          if (previews > 1) throw new FyHttpError('gone', 404, 'item_not_found');
          return preview;
        },
        [`POST /v1/catalogs/${SECOND}/items`]: () => {
          throw new FyHttpError('moved', 409, 'current_changed');
        },
      },
    });
    await pickMenu('Add to another catalog…');
    await click(q('[data-catalog-add]'));
    expect(q('[data-catalog-preview-block]')).toBeNull();
    expect(q('[data-catalog-sheet="add"]')?.textContent).toContain('Preview');
    await view.unmount();
  });

  it('offers a new catalog when every catalog already lists it', async () => {
    const { view } = await show({
      catalogs: [ownedCatalog({ role: 'default' })],
      more: existingHandlers(),
    });
    await pickMenu('Add to another catalog…');
    expect(q('[data-catalog-sheet="add"]')?.textContent).toContain('It is in all your catalogs already.');
    expect(q('[data-catalog-picker]')).toBeNull();
    expect(q('[data-catalog-new-name]')).not.toBeNull();
    await view.unmount();
  });

  it('opens the plain sheet when the machine has no item table, or does not know the item', async () => {
    const noTable = await show({ features: [] });
    await pickMenu('Add to another catalog…');
    expect(q('[data-catalog-sheet="add"]')?.textContent).toContain('Add to catalog');
    await noTable.view.unmount();
    document.body.replaceChildren();
    const unknown = await show({
      more: existingHandlers(sharedItem({ source: { kind: 'skill', path: '/elsewhere/SKILL.md' }, name: 'other' })),
    });
    await pickMenu('Add to another catalog…');
    expect(q('[data-catalog-sheet="add"]')?.textContent).toContain('Add to catalog');
    expect(q('[data-catalog-sheet="add"]')?.textContent).not.toContain('another');
    await unknown.view.unmount();
  });

  it('says why when the item table cannot be read', async () => {
    const { view } = await show({
      more: {
        'GET /v1/catalog-items': () => {
          throw new FyHttpError('no', 409, 'items_full');
        },
      },
    });
    await pickMenu('Add to another catalog…');
    expect(q('[data-catalog-sheet="add"]')).toBeNull();
    expect(document.body.textContent).toContain('shared items');
    await view.unmount();
  });
});
