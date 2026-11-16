/**
 * One ferret row. Ported from today's `sessions-bar-row-title.test.tsx` (a labelled session shows its name, never its
 * batch label), plus the row menu seam: without a provider a row has no ⋯ and leaves the browser's right-click alone;
 * with one, a right-click and the ⋯ button each ask it for the menu of THAT ferret. (v4's outdated-glyph describe is
 * Unit 3's: the glyph is on the remainder line.)
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { FerretRow } from '../../../../app/features/list/ferret-row.tsx';
import { RowMenuContext, type RowMenuRequest } from '../../../../app/features/list/row-menu-context.ts';
import type { FerretSummary } from '../../../../contract/index.ts';
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
