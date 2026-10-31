import { beforeAll, describe, expect, it } from 'bun:test';
import { SharedWithMe } from '../../../../src/features/shared/shared-with-me.tsx';
import {
  LEAVE_NOTE,
  LEFT_SENTENCE,
  NOTHING_SHARED,
  ONLINE_ONLY,
  REFUSED_SENTENCE,
  REFUSED_TITLE,
  UNLOCK_NOTE,
} from '../../../../src/features/shared/shared-model.ts';
import { NAME_NOT_SAVED, NAME_PROBLEM, NOT_PAIRED_NOTE } from '../../../../src/features/shared/shared-screens-model.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fingerprintHead, type MemberSubscription } from '../../../../src/lib/member-keys.ts';
import { testSubscription } from '../../../support/member-keys.ts';
import { click, settle, typeInto } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';
import {
  deferred,
  failedAttempt,
  fakeMembers,
  type Members,
  okAttempt,
  refusedAttempt,
  type SharedItemFixture,
  sharedItemFixture,
} from '../../../support/shared-screens.ts';

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const text = (): string => document.body.textContent ?? '';

const studioId = `fy_daemon_${'q'.repeat(43)}`;
const loftId = `fy_daemon_${'r'.repeat(43)}`;

let shared: SharedItemFixture;
let studio: MemberSubscription;
let loft: MemberSubscription;
beforeAll(async () => {
  shared = await sharedItemFixture();
  studio = await testSubscription(studioId, { ownLabel: 'Studio' });
  loft = await testSubscription(loftId, { ownLabel: 'Loft', daemonName: 'loft-box' });
});

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });

async function open(handlers: Parameters<typeof fakeMembers>[0], options: { machines?: boolean } = {}) {
  const fake = fakeMembers(handlers);
  let homes = 0;
  const view = await mount(
    <SharedWithMe
      members={fake.members}
      machines={options.machines === true ? [{ connection: alpha, name: 'Studio laptop' }] : []}
      onHome={() => {
        homes += 1;
      }}
    />,
  );
  await settle();
  return { ...fake, view, homes: () => homes };
}

const browseOk = async () => okAttempt(shared.browse);
const two = (): Partial<Members> => ({ list: async () => [studio, loft], browse: browseOk });

describe('nothing shared yet', () => {
  it('says so, with the way to start, and goes back', async () => {
    const { view, homes } = await open({ list: async () => [] });
    expect(q('h1')?.textContent).toBe('Shared with me');
    expect(q('[data-shared-empty]')?.textContent).toBe(NOTHING_SHARED);
    await click(q('[data-shared-home]'));
    expect(homes()).toBe(1);
    await view.unmount();
  });

  it('says it is reading while the list has not come', async () => {
    const gate = deferred<readonly MemberSubscription[]>();
    const { view } = await open({ list: async () => await gate.promise });
    expect(text()).toContain('Reading what is shared with you');
    gate.resolve([]);
    await settle();
    await view.unmount();
  });
});

describe('two publishers', () => {
  it('shows each with the person’s own name and the head of the fingerprint, and what each shares', async () => {
    const { view, calls } = await open(two());
    const cards = all('[data-shared-publisher]');
    expect(cards.map(card => card.querySelector('[data-publisher-label]')?.textContent)).toEqual(['Studio', 'Loft']);
    expect(cards[0]?.querySelector('[data-fingerprint]')?.textContent).toBe(`${fingerprintHead(studioId)}…`);
    expect(cards[1]?.querySelector('[data-fingerprint]')?.textContent).toBe(`${fingerprintHead(loftId)}…`);
    expect(text()).not.toContain('loft-box');
    expect(calls.filter(call => call === 'browse')).toHaveLength(2);
    const item = cards[0]?.querySelector('[data-shared-item]');
    expect(item?.textContent).toContain('pdf-tools · Skill · version 1');
    expect(item?.textContent).toContain('Split, merge and OCR PDFs');
    expect(cards[0]?.querySelector('[data-shared-catalog]')?.textContent).toContain("Kirin's catalog");
    await view.unmount();
  });

  it('shows only the sentence for a catalog that did not verify', async () => {
    const problem = {
      ...shared.browse,
      catalogs: [
        { catalogId: shared.view.catalogId, name: 'Broken', revision: 1, problem: 'This catalog was not shown.' },
      ],
    };
    const { view } = await open({ list: async () => [studio], browse: async () => okAttempt(problem) });
    expect(q('[data-shared-catalog-problem]')?.textContent).toBe('This catalog was not shown.');
    expect(q('[data-shared-item]')).toBeNull();
    await view.unmount();
  });

  it('says a catalog with no items has none', async () => {
    const empty = {
      ...shared.browse,
      catalogs: [{ ...shared.view, manifest: { ...shared.view.manifest, items: [] } }],
    } as unknown as typeof shared.browse;
    const { view } = await open({ list: async () => [studio], browse: async () => okAttempt(empty) });
    expect(text()).toContain('This catalog has no items yet.');
    await view.unmount();
  });
});

describe('a key that is locked', () => {
  it('asks for the passkey, unlocks, and then shows what is shared', async () => {
    let browses = 0;
    const { view, calls } = await open({
      list: async () => [studio],
      browse: async () => {
        browses += 1;
        return browses === 1 ? failedAttempt('locked', 'Unlock with your passkey first.') : okAttempt(shared.browse);
      },
      unlock: async () => okAttempt('unlocked'),
    });
    expect(q('[data-shared-locked]')?.textContent).toContain(UNLOCK_NOTE);
    expect(q('[data-publisher-unlock]')?.textContent).toBe('Unlock with passkey');
    await click(q('[data-publisher-unlock]'));
    expect(q('[data-shared-locked]')).toBeNull();
    expect(q('[data-shared-item]')).not.toBeNull();
    expect(calls).toEqual(['list', 'browse', 'unlock', 'browse']);
    await view.unmount();
  });

  it('keeps the unlock with its sentence when the passkey fails, and shows Working… on the way', async () => {
    const gate = deferred<ReturnType<typeof failedAttempt<string>>>();
    const { view } = await open({
      list: async () => [studio],
      browse: async () => failedAttempt('locked', 'Unlock with your passkey first.'),
      unlock: async () => await gate.promise,
    });
    await click(q('[data-publisher-unlock]'));
    expect(q('[data-publisher-unlock]')?.textContent).toBe('Working…');
    gate.resolve(failedAttempt('ceremony', 'Use the same device.'));
    await settle();
    expect(text()).toContain('Use the same device.');
    await view.unmount();
  });

  it('is refused from an unlock', async () => {
    const { view } = await open({
      list: async () => [studio],
      browse: async () => failedAttempt('locked', 'Unlock with your passkey first.'),
      unlock: async () => refusedAttempt(),
    });
    await click(q('[data-publisher-unlock]'));
    expect(q('[data-access-refused]')).not.toBeNull();
    await view.unmount();
  });
});

describe('being offline', () => {
  it('says it needs a connection, keeps nothing, and tries again on request', async () => {
    let browses = 0;
    const { view } = await open({
      list: async () => [studio],
      browse: async () => {
        browses += 1;
        return browses === 1
          ? failedAttempt('unreachable', 'Could not reach the publisher.')
          : okAttempt(shared.browse);
      },
    });
    expect(q('[data-shared-offline]')?.textContent).toContain(ONLINE_ONLY);
    expect(q('[data-shared-item]')).toBeNull();
    await click(q('[data-publisher-again]'));
    expect(q('[data-shared-offline]')).toBeNull();
    expect(q('[data-shared-item]')).not.toBeNull();
    await view.unmount();
  });

  it('says any other failure in its own sentence with Try again', async () => {
    const { view } = await open({
      list: async () => [studio],
      browse: async () => failedAttempt('other', 'That did not work. Try again in a moment.'),
    });
    expect(q('[data-catalog-failure]')?.textContent).toContain('That did not work.');
    await view.unmount();
  });
});

describe('Access refused', () => {
  const refusedList = async () => [await testSubscription(studioId, { ownLabel: 'Studio', status: 'refused' })];

  it('asks the publisher nothing, shows the refusal, and offers no Leave', async () => {
    const { view, calls } = await open({ list: refusedList });
    expect(q('[data-access-refused] h3')?.textContent).toBe(REFUSED_TITLE);
    expect(text()).toContain(REFUSED_SENTENCE);
    expect(q('[data-publisher-leave]')).toBeNull();
    expect(calls).toEqual(['list']);
    await view.unmount();
  });

  it('forgets only when the person confirms, then the list is read again', async () => {
    let gone = false;
    const { view, calls } = await open({
      list: async () => (gone ? [] : await refusedList()),
      forget: async () => {
        gone = true;
      },
    });
    await click(q('[data-refused-forget]'));
    expect(calls).not.toContain('forget');
    await click(q('[data-refused-keep]'));
    expect(calls).not.toContain('forget');
    await click(q('[data-refused-forget]'));
    await click(q('[data-refused-forget-yes]'));
    await settle();
    expect(calls).toContain('forget');
    expect(q('[data-shared-empty]')).not.toBeNull();
    await view.unmount();
  });

  it('shows it when a browse finds the key refused', async () => {
    const { view } = await open({ list: async () => [studio], browse: async () => refusedAttempt() });
    expect(q('[data-access-refused]')).not.toBeNull();
    await view.unmount();
  });
});

describe('renaming a publisher', () => {
  it('saves the person’s own name and reads the list again', async () => {
    let label = 'Studio';
    const renames: string[][] = [];
    const { view } = await open({
      list: async () => [{ ...studio, ownLabel: label }],
      browse: browseOk,
      rename: async (daemonId, next) => {
        renames.push([daemonId, next]);
        label = next;
        return true;
      },
    });
    await click(q('[data-publisher-rename]'));
    await typeInto(q('[data-publisher-rename-input]'), '  Work  ');
    await click(q('[data-publisher-rename-save]'));
    await settle();
    expect(renames).toEqual([[studioId, 'Work']]);
    expect(q('[data-publisher-label]')?.textContent).toBe('Work');
    expect(q('[data-publisher-rename-form]')).toBeNull();
    await view.unmount();
  });

  it('refuses an empty name and a name that is too long without asking anyone', async () => {
    const { view, calls } = await open({ list: async () => [studio], browse: browseOk });
    await click(q('[data-publisher-rename]'));
    await typeInto(q('[data-publisher-rename-input]'), '   ');
    await click(q('[data-publisher-rename-save]'));
    expect(q('[data-publisher-rename-form] [role="alert"]')?.textContent).toBe(NAME_PROBLEM);
    await typeInto(q('[data-publisher-rename-input]'), 'x'.repeat(61));
    await click(q('[data-publisher-rename-save]'));
    expect(q('[data-publisher-rename-form] [role="alert"]')?.textContent).toBe(NAME_PROBLEM);
    expect(calls).not.toContain('rename');
    await click(q('[data-publisher-rename-cancel]'));
    expect(q('[data-publisher-rename-form]')).toBeNull();
    expect(q('[data-publisher-label]')?.textContent).toBe('Studio');
    await view.unmount();
  });

  it('says a name that was not saved was not saved', async () => {
    const { view } = await open({ list: async () => [studio], browse: browseOk, rename: async () => false });
    await click(q('[data-publisher-rename]'));
    await typeInto(q('[data-publisher-rename-input]'), 'Work');
    await click(q('[data-publisher-rename-save]'));
    expect(q('[data-publisher-rename-form] [role="alert"]')?.textContent).toBe(NAME_NOT_SAVED);
    await view.unmount();
  });
});

describe('leaving a publisher', () => {
  it('asks first, keeps everything on Keep it, and says LEFT_SENTENCE after Yes', async () => {
    let left = false;
    const { view, calls } = await open({
      list: async () => (left ? [loft] : [studio, loft]),
      browse: browseOk,
      leave: async () => {
        left = true;
        return okAttempt(undefined);
      },
    });
    const first = () => q(`[data-shared-publisher="${studioId}"]`) as HTMLElement;
    await click(first().querySelector('[data-publisher-leave]'));
    expect(first().textContent).toContain(LEAVE_NOTE);
    expect(calls).not.toContain('leave');
    await click(first().querySelector('[data-publisher-leave-keep]'));
    expect(first().querySelector('[data-publisher-leave-yes]')).toBeNull();
    expect(calls).not.toContain('leave');
    await click(first().querySelector('[data-publisher-leave]'));
    await click(first().querySelector('[data-publisher-leave-yes]'));
    await settle();
    expect(q('[data-shared-left]')?.textContent).toBe(LEFT_SENTENCE);
    expect(q(`[data-shared-publisher="${studioId}"]`)).toBeNull();
    expect(q(`[data-shared-publisher="${loftId}"]`)).not.toBeNull();
    await view.unmount();
  });

  it('says why it could not leave', async () => {
    const { view } = await open({
      list: async () => [studio],
      browse: browseOk,
      leave: async () => failedAttempt('unreachable', 'Could not reach the publisher.'),
    });
    await click(q('[data-publisher-leave]'));
    await click(q('[data-publisher-leave-yes]'));
    expect(text()).toContain('Could not reach the publisher.');
    expect(q('[data-shared-left]')).toBeNull();
    expect(q('[data-publisher-leave]')).not.toBeNull();
    await view.unmount();
  });

  it('shows Access refused when the key was refused', async () => {
    const { view } = await open({ list: async () => [studio], browse: browseOk, leave: async () => refusedAttempt() });
    await click(q('[data-publisher-leave]'));
    await click(q('[data-publisher-leave-yes]'));
    expect(q('[data-access-refused]')).not.toBeNull();
    await view.unmount();
  });
});

describe('opening an item', () => {
  const opened = async () => okAttempt({ item: shared.skill, opened: shared.opened });

  it('shows the full review of what the publisher signed, and closes it', async () => {
    const { view, calls } = await open({ list: async () => [studio], browse: browseOk, openItem: opened });
    await click(q('[data-shared-item]'));
    expect(calls.at(-1)).toBe('openItem');
    expect(q('[data-catalog-sheet="shared-item"]')).not.toBeNull();
    expect(q('[data-review-file="SKILL.md"]')).not.toBeNull();
    expect(text()).toContain(NOT_PAIRED_NOTE);
    await click(q('button[aria-label="Close pdf-tools"]'));
    expect(q('[data-catalog-sheet="shared-item"]')).toBeNull();
    await view.unmount();
  });

  it('offers Install on a machine when a machine is paired', async () => {
    const { view } = await open({ list: async () => [studio], browse: browseOk, openItem: opened }, { machines: true });
    await click(q('[data-shared-item]'));
    expect(q('[data-shared-install-button]')?.textContent).toBe('Install on a machine');
    await view.unmount();
  });

  it('says Opening… while it fetches', async () => {
    const gate = deferred<Awaited<ReturnType<typeof opened>>>();
    const { view } = await open({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => await gate.promise,
    });
    await click(q('[data-shared-item]'));
    expect(q('[data-shared-item]')?.textContent).toContain('Opening…');
    gate.resolve(await opened());
    await settle();
    await view.unmount();
  });

  it('says why an item could not be opened, and never shows it', async () => {
    const { view } = await open({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => failedAttempt('gone', 'The publisher took this item out. It cannot be opened.'),
    });
    await click(q('[data-shared-item]'));
    expect(text()).toContain('The publisher took this item out.');
    expect(q('[data-catalog-sheet="shared-item"]')).toBeNull();
    await view.unmount();
  });

  it('shows Access refused when the key was refused', async () => {
    const { view } = await open({
      list: async () => [studio],
      browse: browseOk,
      openItem: async () => refusedAttempt(),
    });
    await click(q('[data-shared-item]'));
    expect(q('[data-access-refused]')).not.toBeNull();
    await view.unmount();
  });
});
