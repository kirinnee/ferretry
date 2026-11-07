import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { AnalyticsQueryAutocomplete } from '../../../../app/features/analytics/analytics-query-autocomplete.tsx';
import { interact, mount, must } from '../support/dom.ts';

const QUERY = 'sum(tokens) by (model) [7d]';

function Harness({ initial }: { readonly initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <AnalyticsQueryAutocomplete
      value={value}
      onValueChange={setValue}
      onRun={() => undefined}
      loadValues={async () => []}
    />
  );
}

/** Edits the box the way a keyboard or a paste does: native setter, caret after the edit, then `input`. */
const edit = async (box: HTMLTextAreaElement, next: string, caret: number, selectionEnd = caret): Promise<void> => {
  await interact(() => {
    const setter = must(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set, 'a setter');
    setter.call(box, next);
    box.setSelectionRange(caret, selectionEnd);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const mounted = async (initial: string) => {
  const view = await mount(<Harness initial={initial} />);
  const box = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the query box');
  return { view, box };
};

describe('AnalyticsQueryAutocomplete line breaks', () => {
  test('a newline typed mid-query becomes a space and the caret stays right after it', async () => {
    const { view, box } = await mounted(QUERY);
    await edit(box, `${QUERY.slice(0, 3)}\n${QUERY.slice(3)}`, 4);
    expect(box.value).toBe('sum (tokens) by (model) [7d]');
    expect([box.selectionStart, box.selectionEnd]).toEqual([4, 4]);
    await view.unmount();
  });

  test('a multi-line paste in the middle lands the caret right after the pasted text', async () => {
    const { view, box } = await mounted(QUERY);
    const pasted = 'a\r\nb\nc';
    await edit(box, `${QUERY.slice(0, 3)}${pasted}${QUERY.slice(3)}`, 3 + pasted.length);
    expect(box.value).toBe('suma b c(tokens) by (model) [7d]');
    expect([box.selectionStart, box.selectionEnd]).toEqual([3 + 'a b c'.length, 3 + 'a b c'.length]);
    await view.unmount();
  });

  test('a replaced selection keeps its extent measured on the normalised text', async () => {
    const { view, box } = await mounted(QUERY);
    await edit(box, 'x\r\ny', 0, 4);
    expect(box.value).toBe('x y');
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 3]);
    await view.unmount();
  });

  test('an edit without a line break leaves the caret to the browser', async () => {
    const { view, box } = await mounted(QUERY);
    await edit(box, `${QUERY.slice(0, 3)}Z${QUERY.slice(3)}`, 4);
    expect(box.value).toBe('sumZ(tokens) by (model) [7d]');
    expect([box.selectionStart, box.selectionEnd]).toEqual([4, 4]);
    await view.unmount();
  });
});
