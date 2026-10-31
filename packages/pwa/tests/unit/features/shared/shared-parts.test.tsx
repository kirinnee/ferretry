import { describe, expect, it } from 'bun:test';
import { AccessRefused, JoinAgain } from '../../../../src/features/shared/access-refused.tsx';
import { Fingerprint, SharedPage } from '../../../../src/features/shared/shared-parts.tsx';
import {
  FORGET_NOTE,
  REFUSED_JOIN_AGAIN,
  REFUSED_JOIN_AGAIN_NOTE,
  REFUSED_SENTENCE,
  REFUSED_TITLE,
  STILL_REFUSED_SENTENCE,
} from '../../../../src/features/shared/shared-model.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';
import { failedAttempt } from '../../../support/shared-screens.ts';

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

describe('SharedPage', () => {
  it('is one main with one heading, framed unless told it sits in a frame already', async () => {
    const view = await mount(
      <>
        <SharedPage title="Framed">body</SharedPage>
        <SharedPage title="Flush" flush>
          body
        </SharedPage>
      </>,
    );
    const pages = [...document.querySelectorAll('[data-shared-page]')];
    expect(pages.map(page => page.querySelector('h1')?.textContent)).toEqual(['Framed', 'Flush']);
    expect(pages[0]?.className).toContain('px-3');
    expect(pages[1]?.className).not.toContain('px-3');
    await view.unmount();
  });
});

describe('Fingerprint', () => {
  it('shows the head, the whole when tapped, and the head again', async () => {
    const view = await mount(<Fingerprint head="fy_daemon_12345678" full="fy_daemon_1234567890abcdef" />);
    const button = q('[data-fingerprint]') as HTMLElement;
    expect(button.textContent).toContain('fy_daemon_12345678');
    expect(button.textContent).not.toContain('abcdef');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await click(button);
    expect(button.textContent).toContain('fy_daemon_1234567890abcdef');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await click(button);
    expect(button.textContent).not.toContain('abcdef');
    await view.unmount();
  });
});

describe('Fingerprint label', () => {
  it('says Machine ID by default and takes another label', async () => {
    const view = await mount(<Fingerprint head="abc" full="abcdef" />);
    expect(q('[data-fingerprint]')?.parentElement?.textContent).toBe('Machine ID:abc…');
    expect(q('[data-fingerprint]')?.getAttribute('aria-label')).toContain('Machine ID');
    await view.unmount();
    const other = await mount(<Fingerprint head="abc" full="abcdef" label="Compare" />);
    expect(q('[data-fingerprint]')?.parentElement?.textContent).toBe('Compare:abc…');
    await other.unmount();
  });
});

describe('JoinAgain', () => {
  it('says what to do and fetches nothing', async () => {
    const view = await mount(<JoinAgain />);
    expect(q('[data-join-again-note]')).toBeNull();
    await click(q('[data-join-again]'));
    expect(q('[data-join-again-note]')?.textContent).toBe(REFUSED_JOIN_AGAIN_NOTE);
    expect(q('[data-join-again]')?.textContent).toBe(REFUSED_JOIN_AGAIN);
    await view.unmount();
  });
});

describe('AccessRefused', () => {
  it('says the key was refused, deletes nothing, and forgets only after Yes', async () => {
    const forgotten: string[] = [];
    const view = await mount(
      <AccessRefused
        label="Studio"
        level={2}
        onTryAgain={async () => ({ kind: 'ok', value: undefined })}
        onForget={async () => {
          forgotten.push('forgotten');
        }}
      />,
    );
    expect(q('[data-access-refused] h2')?.textContent).toBe(REFUSED_TITLE);
    expect(q('[data-access-refused]')?.textContent).toContain(REFUSED_SENTENCE);
    expect(q('[data-access-refused]')?.textContent).toContain(FORGET_NOTE);
    expect(forgotten).toEqual([]);

    await click(q('[data-refused-forget]'));
    expect(forgotten).toEqual([]);
    expect(q('[data-refused-forget-yes]')).not.toBeNull();
    await click(q('[data-refused-keep]'));
    expect(q('[data-refused-forget-yes]')).toBeNull();
    expect(forgotten).toEqual([]);

    await click(q('[data-refused-forget]'));
    await click(q('[data-refused-forget-yes]'));
    await settle();
    expect(forgotten).toEqual(['forgotten']);
    await view.unmount();
  });

  it('offers Try again first, then a new link, and Forget last', async () => {
    const view = await mount(
      <AccessRefused
        label="Studio"
        level={3}
        onTryAgain={async () => ({ kind: 'ok', value: undefined })}
        onForget={async () => undefined}
      />,
    );
    const order = [...document.querySelectorAll('[data-access-refused] button')].map(button =>
      ['data-refused-try-again', 'data-join-again', 'data-refused-forget'].find(name => button.hasAttribute(name)),
    );
    expect(order).toEqual(['data-refused-try-again', 'data-join-again', 'data-refused-forget']);
    await view.unmount();
  });

  it('says it was refused again, and keeps every choice, when Try again is refused', async () => {
    const view = await mount(
      <AccessRefused
        label="Studio"
        level={3}
        onTryAgain={async () => ({ kind: 'refused' })}
        onForget={async () => undefined}
      />,
    );
    await click(q('[data-refused-try-again]'));
    await settle();
    expect(q('[data-access-refused]')?.textContent).toContain(STILL_REFUSED_SENTENCE);
    expect(q('[data-refused-forget]')).not.toBeNull();
    await view.unmount();
  });

  it('says why when the publisher could not be reached', async () => {
    const view = await mount(
      <AccessRefused
        label="Studio"
        level={3}
        onTryAgain={async () => failedAttempt('unreachable', 'Could not reach it.')}
        onForget={async () => undefined}
      />,
    );
    await click(q('[data-refused-try-again]'));
    await settle();
    expect(q('[data-access-refused]')?.textContent).toContain('Could not reach it.');
    await view.unmount();
  });

  it('sits one heading level down in a list of publishers', async () => {
    const view = await mount(
      <AccessRefused
        label="Studio"
        level={3}
        onTryAgain={async () => ({ kind: 'ok', value: undefined })}
        onForget={async () => undefined}
      />,
    );
    expect(q('[data-access-refused] h3')?.textContent).toBe(REFUSED_TITLE);
    await view.unmount();
  });
});
