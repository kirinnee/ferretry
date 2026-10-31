import { describe, expect, it } from 'bun:test';
import { SharedEntry } from '../../../../src/features/shared/shared-entry.tsx';
import { SEE_SHARED } from '../../../../src/features/shared/shared-screens-model.ts';
import { testSubscription } from '../../../support/member-keys.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';
import { fakeMembers } from '../../../support/shared-screens.ts';

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

describe('the way into Shared with me', () => {
  it('shows only when this browser holds a key, and opens the page', async () => {
    const sub = await testSubscription('fy_daemon_x');
    const { members } = fakeMembers({ list: async () => [sub] });
    const opened: string[] = [];
    const view = await mount(<SharedEntry members={members} onOpen={() => opened.push('opened')} />);
    await settle();
    expect(q('[data-shared-entry] button')?.textContent).toBe(SEE_SHARED);
    await click(q('[data-shared-entry] button'));
    expect(opened).toEqual(['opened']);
    await view.unmount();
  });

  it('is not drawn when nothing is shared, or when the keys cannot be read', async () => {
    const empty = await mount(
      <SharedEntry members={fakeMembers({ list: async () => [] }).members} onOpen={() => undefined} />,
    );
    await settle();
    expect(q('[data-shared-entry]')).toBeNull();
    await empty.unmount();
    const broken = await mount(
      <SharedEntry
        members={fakeMembers({ list: async () => Promise.reject(new Error('no storage')) }).members}
        onOpen={() => undefined}
      />,
    );
    await settle();
    expect(q('[data-shared-entry]')).toBeNull();
    await broken.unmount();
  });

  it('does not set state after it is gone', async () => {
    let release: (value: readonly never[]) => void = () => undefined;
    const members = fakeMembers({ list: () => new Promise(done => (release = done as typeof release)) }).members;
    const view = await mount(<SharedEntry members={members} onOpen={() => undefined} />);
    await view.unmount();
    release([]);
    await settle();
  });
});
