import { describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PullAddress, PullsClient } from '../../../app/features/compose/api.ts';
import { ComposeDock, QuoteScope } from '../../../app/features/compose/index.ts';
import { DiffSelectionScope } from '../../../app/features/compose/scopes.tsx';

const ADDRESS: PullAddress = {
  project: '11111111-1111-4111-8111-111111111111',
  owner: 'octo',
  name: 'demo',
  number: 7,
};
const client: PullsClient = { call: (async () => ({ login: 'octo-fake' })) as PullsClient['call'] };

/** Selects from the start of one node's text to the end of another's, as a person dragging would. */
function select(from: Node, to: Node, toOffset?: number): void {
  const selection = must(window.getSelection(), 'a selection');
  const range = document.createRange();
  range.setStart(from, 0);
  range.setEnd(to, toOffset ?? (to.textContent ?? '').length);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}
const textOf = (root: ParentNode, selector: string): Node =>
  must(must(root.querySelector(selector), selector).firstChild, selector);
const actions = (mounted: Mounted, name: string) =>
  mounted.container.querySelector(`[data-selection-actions="${name}"]`);
const buttons = (mounted: Mounted, name: string) =>
  [...(actions(mounted, name)?.querySelectorAll('button') ?? [])].map(button => button.textContent);

const frame = (children: ReactNode) => (
  <ComposeDock
    address={ADDRESS}
    client={client}
    headSha={'b'.repeat(40)}
    onChanged={() => undefined}
    pullUrl="https://github.com/octo/demo/pull/7"
  >
    {children}
  </ComposeDock>
);

describe('quoting a selection in the conversation', () => {
  it('offers Quote under a selection inside GitHub text, and not for a heading or an empty selection', async () => {
    const mounted = await mount(
      frame(
        <QuoteScope>
          <h2 data-title="">A heading</h2>
          <div data-gh-text="">
            <p data-p1="">Keep the old route for one release.</p>
            <p data-p2="">Second paragraph.</p>
          </div>
        </QuoteScope>,
      ),
    );
    select(textOf(mounted.container, '[data-title]'), textOf(mounted.container, '[data-title]'));
    await interact(() => undefined);
    expect(actions(mounted, 'prose')).toBeNull();
    select(textOf(mounted.container, '[data-p1]'), textOf(mounted.container, '[data-p2]'), 6);
    await settleUntil(() => actions(mounted, 'prose') !== null, 'the Quote button', interact);
    expect(buttons(mounted, 'prose')).toEqual(['Quote']);
    // A selection that begins in the heading and ends in the text is not a quote of GitHub's words.
    select(textOf(mounted.container, '[data-title]'), textOf(mounted.container, '[data-p2]'), 3);
    await settleUntil(() => actions(mounted, 'prose') === null, 'the button going away', interact);
    await mounted.unmount();
  });

  it('Quote opens the comment box with the selected words behind "> " and clears the selection', async () => {
    const mounted = await mount(
      frame(
        <QuoteScope>
          <div data-gh-text="">
            <p data-p1="">Keep the old route for one release.</p>
          </div>
        </QuoteScope>,
      ),
    );
    select(textOf(mounted.container, '[data-p1]'), textOf(mounted.container, '[data-p1]'), 13);
    await settleUntil(() => actions(mounted, 'prose') !== null, 'the Quote button', interact);
    const quote = must(actions(mounted, 'prose')?.querySelector('button'), 'Quote');
    await interact(() => (quote as HTMLButtonElement).click());
    expect(must(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]'), 'box').value).toBe(
      '> Keep the old\n\n',
    );
    expect(actions(mounted, 'prose')).toBeNull();
    await mounted.unmount();
  });
});

describe('selecting diff lines', () => {
  const row = (kind: string, side: string, number: number, text: string) => (
    <div
      data-diff-line={kind}
      data-diff-number={number}
      data-diff-path="src/a.ts"
      data-diff-side={side}
      key={`${side}${number}`}
    >
      <span data-text={`${side}${number}`}>{text}</span>
    </div>
  );
  const scene = (
    <DiffSelectionScope>
      <div>
        {row('context', 'right', 10, 'keep')}
        {row('add', 'right', 11, 'const a = 1;')}
        {row('add', 'right', 12, 'const b = 2;')}
        {row('del', 'left', 11, 'old line')}
        <div data-diff-line="add" data-diff-number="13" data-diff-path="src/b.ts" data-diff-side="right">
          <span data-text="other">other file</span>
          <div data-compose-extras="">
            <span data-text="thread">a thread under the line</span>
          </div>
        </div>
      </div>
    </DiffSelectionScope>
  );

  it('offers Quote and "Comment on these lines" for lines of one file and side, and sets the range in order', async () => {
    const mounted = await mount(frame(scene));
    // Dragged upward: the last line is the start of the range as the page orders it.
    select(textOf(mounted.container, '[data-text="right10"]'), textOf(mounted.container, '[data-text="right12"]'));
    await settleUntil(() => actions(mounted, 'diff') !== null, 'the diff actions', interact);
    expect(buttons(mounted, 'diff')).toEqual(['Quote', 'Comment on these lines']);
    const comment = must(
      [...(actions(mounted, 'diff')?.querySelectorAll('button') ?? [])].find(
        b => b.textContent === 'Comment on these lines',
      ),
      'comment button',
    );
    await interact(() => (comment as HTMLButtonElement).click());
    expect(mounted.container.querySelector('[data-compose-dock="line"] h3')?.textContent).toBe(
      'Comment on src/a.ts:10-12',
    );
    await mounted.unmount();
  });

  it('offers only Quote when the lines are on different sides or files, and nothing for a thread drawn under a line', async () => {
    const mounted = await mount(frame(scene));
    select(textOf(mounted.container, '[data-text="right12"]'), textOf(mounted.container, '[data-text="left11"]'));
    await settleUntil(() => actions(mounted, 'diff') !== null, 'the diff actions', interact);
    expect(buttons(mounted, 'diff')).toEqual(['Quote']);
    select(textOf(mounted.container, '[data-text="right12"]'), textOf(mounted.container, '[data-text="other"]'));
    await settleUntil(() => buttons(mounted, 'diff').join() === 'Quote', 'quote only', interact);
    select(textOf(mounted.container, '[data-text="other"]'), textOf(mounted.container, '[data-text="thread"]'));
    await settleUntil(() => actions(mounted, 'diff') === null, 'no actions', interact);
    await mounted.unmount();
  });

  it('Quote heads the quote with the file and lines', async () => {
    const mounted = await mount(frame(scene));
    select(textOf(mounted.container, '[data-text="right11"]'), textOf(mounted.container, '[data-text="right12"]'));
    await settleUntil(() => actions(mounted, 'diff') !== null, 'the diff actions', interact);
    const quote = must(actions(mounted, 'diff')?.querySelector('button'), 'Quote');
    await interact(() => (quote as HTMLButtonElement).click());
    const value = must(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]'), 'box').value;
    expect(value.startsWith('> `src/a.ts:11-12`\n>\n> ')).toBe(true);
    await mounted.unmount();
  });
});
