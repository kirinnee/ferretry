import { describe, expect, it } from 'bun:test';
import { useState, type ReactElement } from 'react';

import {
  AnalyticsCompletionList,
  AnalyticsQueryAutocomplete,
  analyticsAutocompleteKeyAction,
  applyAnalyticsCompletion,
  createLabelValueCache,
  nextAnalyticsCompletionIndex,
  type ValueCacheEntry,
} from '../../../src/features/analytics/analytics-query-autocomplete.tsx';
import type { AnalyticsCompletion } from '../../../src/features/analytics/analytics-query-complete.ts';
import { render, run, runAsync } from '../../support/react.ts';

const candidates: AnalyticsCompletion[] = [
  {
    id: 'sum',
    kind: 'aggregation',
    label: 'sum',
    detail: 'total',
    replacement: 'sum ',
    group: 'Aggregations',
    rankPriority: 100,
  },
  { id: 'model', kind: 'label', label: 'model', replacement: 'model=', group: 'Labels', rankPriority: 60 },
];

const list = (element: ReactElement) => render(element).root;

function ControlledAutocomplete() {
  const [value, setValue] = useState('su');
  return (
    <AnalyticsQueryAutocomplete
      value={value}
      onValueChange={setValue}
      onRun={() => undefined}
      loadValues={async () => []}
    />
  );
}

describe('analytics query autocomplete', () => {
  it('has the source keyboard contract and clamps completion replacement ranges', () => {
    expect(nextAnalyticsCompletionIndex(3, 2, 1)).toBe(0);
    expect(nextAnalyticsCompletionIndex(3, -1, -1)).toBe(2);
    expect(nextAnalyticsCompletionIndex(0, 0, 1)).toBe(-1);
    expect(analyticsAutocompleteKeyAction('Enter', { open: false, count: 3, activeIndex: 0 })).toEqual({ type: 'run' });
    expect(analyticsAutocompleteKeyAction('Enter', { open: true, count: 3, activeIndex: 0 })).toEqual({
      type: 'accept',
      index: 0,
    });
    expect(analyticsAutocompleteKeyAction('ArrowUp', { open: true, count: 3, activeIndex: 0 })).toEqual({
      type: 'navigate',
      index: 2,
    });
    expect(analyticsAutocompleteKeyAction('Tab', { open: true, count: 3, activeIndex: -1 })).toEqual({
      type: 'ignore',
    });
    expect(analyticsAutocompleteKeyAction('Escape', { open: true, count: 0, activeIndex: -1 })).toEqual({
      type: 'close',
    });
    expect(analyticsAutocompleteKeyAction('x', { open: true, count: 2, activeIndex: 0, composing: true })).toEqual({
      type: 'ignore',
    });
    expect(applyAnalyticsCompletion('su', { start: 40, end: 90 }, 'sum ')).toEqual({
      value: 'susum ',
      selection: { start: 6, end: 6 },
    });
  });

  it('caches one daemon-scoped value load and keeps an error honest', async () => {
    const snapshots: Array<ReadonlyMap<string, ValueCacheEntry>> = [];
    let calls = 0;
    const ready = createLabelValueCache(
      async () => {
        calls += 1;
        return ['running'];
      },
      state => snapshots.push(state),
    );
    await Promise.all([ready.request('status'), ready.request('status')]);
    expect(calls).toBe(1);
    expect(ready.entry('status')).toEqual({ status: 'ready', values: ['running'] });
    expect(snapshots.map(snapshot => snapshot.get('status')?.status)).toEqual(['loading', 'ready']);
    const failed = createLabelValueCache(
      async () => {
        throw new Error('offline');
      },
      () => undefined,
    );
    await failed.request('model');
    expect(failed.entry('model')).toEqual({ status: 'error', error: 'offline' });
  });

  it('renders every list state and only accepts the pointer that started on a row', () => {
    expect(
      render(
        <AnalyticsCompletionList
          open={false}
          status="ready"
          candidates={candidates}
          activeIndex={0}
          listboxId="list"
          context="aggregation"
          onAccept={() => undefined}
        />,
      ).toJSON(),
    ).toBeNull();
    expect(
      JSON.stringify(
        render(
          <AnalyticsCompletionList
            open
            status="loading"
            candidates={[]}
            activeIndex={-1}
            listboxId="list"
            context="matcher-value"
            onAccept={() => undefined}
          />,
        ).toJSON(),
      ),
    ).toContain('Loading values');
    expect(
      list(
        <AnalyticsCompletionList
          open
          status="error"
          candidates={[]}
          activeIndex={-1}
          listboxId="list"
          context="matcher-value"
          error="offline"
          onAccept={() => undefined}
        />,
      )
        .findByProps({ role: 'alert' })
        .children.join(''),
    ).toContain('offline');
    expect(
      JSON.stringify(
        render(
          <AnalyticsCompletionList
            open
            status="ready"
            candidates={[]}
            activeIndex={-1}
            listboxId="list"
            context="matcher-value"
            notice="No values"
            onAccept={() => undefined}
          />,
        ).toJSON(),
      ),
    ).toContain('No values');
    const accepted: number[] = [];
    const root = list(
      <AnalyticsCompletionList
        open
        status="ready"
        candidates={candidates}
        activeIndex={0}
        listboxId="list"
        context="aggregation"
        notice="Ranked"
        onAccept={index => accepted.push(index)}
      />,
    );
    expect(root.findByProps({ role: 'listbox' }).props.id).toBe('list');
    const row = root.findAllByProps({ role: 'option' })[0]!;
    run(() => row.props.onPointerDown({ pointerId: 1, preventDefault() {} }));
    run(() => row.props.onPointerUp({ pointerId: 2 }));
    run(() => row.props.onPointerCancel());
    run(() => row.props.onPointerDown({ pointerId: 3, preventDefault() {} }));
    run(() => row.props.onPointerUp({ pointerId: 3 }));
    expect(accepted).toEqual([0]);
  });

  it('is an active-descendant combobox that opens, navigates, runs, and accepts without moving focus', async () => {
    const values: string[] = [];
    let runs = 0;
    const renderer = render(
      <AnalyticsQueryAutocomplete
        value="su"
        onValueChange={value => values.push(value)}
        onRun={() => {
          runs += 1;
        }}
        inputId="query"
        loadValues={async () => ['running']}
      />,
    );
    const input = renderer.root.findByProps({ role: 'combobox' });
    expect(input.props['aria-expanded']).toBe(false);
    run(() => input.props.onFocus());
    expect(renderer.root.findByProps({ role: 'combobox' }).props['aria-expanded']).toBe(true);
    run(() => input.props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, nativeEvent: { isComposing: false } }));
    run(() => input.props.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: { isComposing: false } }));
    expect(values).toEqual(['min ']);
    run(() => input.props.onChange({ currentTarget: { value: 'sum', selectionStart: 3 } }));
    run(() => input.props.onSelect({ currentTarget: { value: 'sum', selectionStart: null } }));
    run(() => input.props.onBlur());
    run(() => input.props.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: { isComposing: false } }));
    expect(runs).toBe(1);
    await runAsync(async () => undefined);
  });

  it('loads pending low-cardinality values through the caller-provided daemon loader', async () => {
    const asked: string[] = [];
    render(
      <AnalyticsQueryAutocomplete
        value="{status="
        onValueChange={() => undefined}
        onRun={() => undefined}
        loadValues={async label => {
          asked.push(label);
          return ['running'];
        }}
      />,
    );
    await runAsync(async () => await Promise.resolve());
    expect(asked).toEqual(['status']);
  });

  it('restores the selection only after its controlled completion commits', () => {
    const selections: Array<[number, number]> = [];
    const inputNode = {
      value: 'sum ',
      setSelectionRange: (start: number, end: number) => selections.push([start, end]),
    };
    const renderer = render(<ControlledAutocomplete />, {
      createNodeMock: element => (element.type === 'input' ? inputNode : {}),
    });
    const input = renderer.root.findByProps({ role: 'combobox' });
    run(() => input.props.onFocus());
    run(() => input.props.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: { isComposing: false } }));
    expect(selections).toEqual([[4, 4]]);
  });
});
