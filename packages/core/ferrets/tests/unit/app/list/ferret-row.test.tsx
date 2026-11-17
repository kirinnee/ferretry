/**
 * One ferret row. Ported from today's `sessions-bar-row-title.test.tsx` (a labelled session shows its name, never its
 * batch label), plus the row menu seam: without a provider a row has no ⋯ and leaves the browser's right-click alone;
 * with one, a right-click and the ⋯ button each ask it for the menu of THAT ferret. (v4's outdated-glyph describe is
 * Unit 3's: the glyph is on the remainder line.)
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ComponentProps } from 'react';
import { FerretRow } from '../../../../app/features/list/ferret-row.tsx';
import { RowMenuContext, type RowMenuRequest } from '../../../../app/features/list/row-menu-context.ts';
import { WithSlotPanels } from '@ferretry/app/testing';
import { FERRET_LIST_ROW_MARK_SLOT, type FerretSummary } from '../../../../contract/index.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { summary as ferretSummary } from './support.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const draw = async (ferret: FerretSummary, open?: (request: RowMenuRequest) => void): Promise<Element> => {
  mounted = await mount(
    <RowMenuContext value={open}>
      <ul>
        <FerretRow active={false} daemon="alpha" ferret={ferret} />
      </ul>
    </RowMenuContext>,
  );
  return must(mounted.container.querySelector(`[data-sbar-session="${ferret.id}"]`), 'the row');
};

describe('a ferret row title', () => {
  it('S-0405 a labelled ferret shows its task, so a rename is seen, and never its batch label', async () => {
    const row = await draw(ferretSummary('cyan', { title: 'CyanPrint', label: 'diene-cyan' }));
    expect(row.querySelector('.fy-sbar__name')?.textContent).toBe('CyanPrint');
    expect(row.textContent).not.toContain('diene-cyan');
    await mounted?.unmount();

    const renamed = await draw(ferretSummary('cyan', { title: 'CyanPrint v2', label: 'diene-cyan' }));
    expect(renamed.querySelector('.fy-sbar__name')?.textContent).toBe('CyanPrint v2');
  });

  it('a row carries only the summary fields: the task, the callsign and the folder, never a transcript path', async () => {
    const row = await draw(
      ferretSummary('secret', {
        title: 'A task',
        transcript: { path: '/home/kirin/.claude/projects/x/secret.jsonl' } as never,
      }),
    );
    expect(row.textContent).not.toContain('secret.jsonl');
    expect(row.getAttribute('title')).not.toContain('.claude');
  });
});

describe('the row menu seam', () => {
  it('without a provider the row draws no ⋯ and leaves the browser’s right-click alone', async () => {
    const row = await draw(ferretSummary('a'));
    expect(row.hasAttribute('aria-haspopup')).toBe(false);
    expect(mounted?.container.querySelector('[data-sbar-more]')).toBeNull();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await interact(() => row.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });

  it('with a provider a right-click opens the menu of that ferret at the pointer, and the ⋯ button does too', async () => {
    const requests: RowMenuRequest[] = [];
    const ferret = ferretSummary('a', { title: 'Task a' });
    const row = await draw(ferret, request => requests.push(request));
    expect(row.getAttribute('aria-haspopup')).toBe('menu');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
    await interact(() => row.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(requests[0]).toMatchObject({ ferret, x: 12, y: 34, trigger: 'mouse' });

    const more = must(mounted?.container.querySelector<HTMLButtonElement>('[data-sbar-more]'), 'the ⋯ button');
    expect(more.getAttribute('aria-label')).toBe('Actions for Task a');
    await interact(() => more.click());
    expect(requests).toHaveLength(2);
    expect(requests[1]?.ferret).toBe(ferret);
  });

  it('hands focus back to the row it came from, and says so when that row has left the page', async () => {
    const requests: RowMenuRequest[] = [];
    const row = await draw(ferretSummary('a'), request => requests.push(request));
    await interact(() => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(requests[0]?.focusRow()).toBe(true);
    expect(document.activeElement).toBe(row);
    await mounted?.unmount();
    expect(requests[0]?.focusRow()).toBe(false);
  });
});

describe('the marks other plugins draw on a row', () => {
  const place = (ferret: FerretSummary) => (
    <WithSlotPanels
      slots={{
        [FERRET_LIST_ROW_MARK_SLOT]: [
          {
            plugin: 'usage',
            id: 'quota',
            view: props => (
              <b data-test-mark={`${String(props.ferret)}:${String(props.runtime)}:${String(props.login)}`}>quota</b>
            ),
          },
        ],
      }}
    >
      <ul>
        <FerretRow active={false} daemon="alpha" ferret={ferret} />
      </ul>
    </WithSlotPanels>
  );

  it('hands the ferret, its runtime and its login to what a plugin contributes to the row-mark slot', async () => {
    mounted = await mount(place(ferretSummary('a', { runtime: 'claude-main', login: 'work-login' })));
    const marks = must(mounted.container.querySelector('[data-sbar-marks]'), 'the marks line');
    expect(marks.querySelector('[data-test-mark]')?.getAttribute('data-test-mark')).toBe('a:claude-main:work-login');
    expect(marks.textContent).toBe('quota');
  });

  it('hands no login for a ferret whose record names none, never the runtime in its place', async () => {
    mounted = await mount(place(ferretSummary('a', { runtime: 'claude-main' })));
    expect(mounted.container.querySelector('[data-test-mark]')?.getAttribute('data-test-mark')).toBe(
      'a:claude-main:undefined',
    );
  });

  it('draws no marks line for a ferret that names no runtime, so nothing is asked for an unknown account', async () => {
    mounted = await mount(place({ ...ferretSummary('a'), runtime: undefined }));
    expect(mounted.container.querySelector('[data-sbar-marks]')).toBeNull();
    expect(mounted.container.querySelector('[data-test-mark]')).toBeNull();
  });
});

describe('the pin button and the sub-ferret chevron', () => {
  const place = (props: Partial<ComponentProps<typeof FerretRow>>, ferret = ferretSummary('a')) =>
    mount(
      <ul>
        <FerretRow active={false} daemon="alpha" ferret={ferret} {...props} />
      </ul>,
    );

  it('draws a pin button only when asked, which pins an unpinned ferret and unpins a pinned one', async () => {
    mounted = await place({});
    expect(mounted.container.querySelector('[data-sbar-pin]')).toBeNull();
    await mounted.unmount();

    const calls: boolean[] = [];
    mounted = await place({ onPin: pinned => calls.push(pinned) }, ferretSummary('a', { title: 'Task a' }));
    const pin = must(mounted.container.querySelector<HTMLButtonElement>('[data-sbar-pin]'), 'the pin button');
    expect(pin.getAttribute('aria-label')).toBe('Pin Task a');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await interact(() => pin.click());
    await mounted.unmount();

    mounted = await place(
      { onPin: pinned => calls.push(pinned) },
      ferretSummary('a', { title: 'Task a', pinnedAt: '2026-11-02T10:00:00.000Z' }),
    );
    const unpin = must(mounted.container.querySelector<HTMLButtonElement>('[data-sbar-pin]'), 'the unpin button');
    expect(unpin.getAttribute('aria-label')).toBe('Unpin Task a');
    expect(unpin.getAttribute('aria-pressed')).toBe('true');
    await interact(() => unpin.click());
    expect(calls).toEqual([true, false]);
  });

  it('draws the sub-ferrets only while the branch is open, and says how many there are', async () => {
    let flips = 0;
    mounted = await place({
      branch: { count: 2, open: false, toggle: () => (flips += 1) },
      children: <li data-test-kid="">kid</li>,
    });
    const toggle = must(mounted.container.querySelector<HTMLButtonElement>('[data-sbar-branch-toggle]'), 'the chevron');
    expect(toggle.getAttribute('aria-label')).toBe('Show 2 sub-ferrets of home-manager');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(mounted.container.querySelector('[data-test-kid]')).toBeNull();
    await interact(() => toggle.click());
    expect(flips).toBe(1);
    await mounted.unmount();

    mounted = await place({
      branch: { count: 1, open: true, toggle: () => undefined },
      children: <li data-test-kid="">kid</li>,
    });
    expect(mounted.container.querySelector('[data-sbar-branch-toggle]')?.getAttribute('aria-label')).toContain(
      'Hide 1 sub-ferret of',
    );
    expect(mounted.container.querySelector('.fy-sbar__children [data-test-kid]')).not.toBeNull();
  });
});
