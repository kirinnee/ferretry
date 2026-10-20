import { afterEach, describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ANALYTICS_QUERY_DEFAULT } from '../../../src/features/analytics/analytics-custom-query.tsx';
import { ANALYTICS_QUERY_EXAMPLES } from '../../../src/features/analytics/analytics-query-examples.ts';
import { AnalyticsQueryPage } from '../../../src/features/analytics/analytics-query-page.tsx';
import {
  SAVED_QUERIES_KEY,
  type SavedQueriesStorage,
} from '../../../src/features/analytics/analytics-saved-queries.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import { aggregateResponse, group } from '../../support/analytics-query-fixtures.ts';
import '../../support/dom.ts';
import { render, run, runAsync } from '../../support/react.ts';

const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const renderer of renderers) renderer.unmount();
  });
  renderers.length = 0;
});
const mount = (element: ReactElement): ReactTestRenderer => {
  const renderer = render(element);
  renderers.push(renderer);
  return renderer;
};
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await runAsync(async () => await Promise.resolve());
};
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'children' in node)
    return textOf((node as { children: unknown }).children);
  return '';
};
const text = (renderer: ReactTestRenderer): string => textOf(renderer.toJSON());

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
const NOW = () => new Date('2026-10-16T12:34:00Z');

const answer = (query: string): AnalyticsResponse =>
  aggregateResponse(
    query,
    [group({ model: 'claude-opus-5-5' }), group({ model: 'gpt-6-astra' }, { sessions: 2 })],
    { groupBy: ['model'], metric: 'cost_usd' },
  );
const fleet = (calls: string[]) => async (_daemon: unknown, query?: string) => {
  calls.push(query ?? '');
  return answer(query ?? '');
};
const memory = (): SavedQueriesStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};
const input = (renderer: ReactTestRenderer) => renderer.root.findByProps({ role: 'combobox' });
const type = (renderer: ReactTestRenderer, value: string) =>
  run(() => input(renderer).props.onChange({ currentTarget: { value, selectionStart: value.length } }));
const submit = async (renderer: ReactTestRenderer) => {
  await runAsync(async () => {
    renderer.root.findAllByType('form')[0]!.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  await settle();
};
const button = (renderer: ReactTestRenderer, label: string): ReactTestInstance =>
  renderer.root.findAll(node => node.type === 'button' && textOf(node.children) === label)[0]!;

describe('AnalyticsQueryPage', () => {
  it('opens with the default query, asks nothing, then runs it into a chart and a table', async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const renderer = mount(
      <AnalyticsQueryPage
        connection={daemonA}
        requestAnalytics={fleet(calls)}
        now={NOW}
        onQueryChange={query => seen.push(query)}
      />,
    );
    expect(calls).toEqual([]);
    expect(input(renderer).props.value).toBe(ANALYTICS_QUERY_DEFAULT);
    expect(text(renderer)).toContain('Run a query, or start from an example below.');
    expect(text(renderer)).toContain('this machine');
    await submit(renderer);
    expect(calls).toEqual([ANALYTICS_QUERY_DEFAULT]);
    expect(seen).toEqual([ANALYTICS_QUERY_DEFAULT]);
    expect(text(renderer)).toContain('Ran at 12:34 UTC');
    expect(text(renderer)).toContain('claude-opus-5-5');
    expect(text(renderer)).toContain('$12.34');
    expect(renderer.root.findAllByType('table').length).toBeGreaterThan(0);
  });

  it('runs a query that arrived with the link once, and says how many machines', async () => {
    const calls: string[] = [];
    const renderer = mount(
      <AnalyticsQueryPage
        connection={daemonA}
        connections={[daemonA, daemonB]}
        requestAnalytics={fleet(calls)}
        initialQuery="sum(turns) by (model)"
      />,
    );
    await settle();
    expect(calls).toEqual(['sum(turns) by (model)']);
    expect(text(renderer)).toContain('across 2 machines');
  });

  it('reports a failed query and a 503 in words, and clears the old answer', async () => {
    let fail: unknown = new Error('offline');
    const renderer = mount(
      <AnalyticsQueryPage
        connection={daemonA}
        requestAnalytics={async (_d, query) => {
          if (fail) throw fail;
          return answer(query ?? '');
        }}
      />,
    );
    await submit(renderer);
    expect(text(renderer)).toContain('The query failed: offline');
    fail = new DaemonResponseError(503, 'x');
    await submit(renderer);
    expect(text(renderer)).toContain('Analytics index is unavailable');
    fail = null;
    await submit(renderer);
    expect(text(renderer)).not.toContain('The query failed');
  });

  it('shows the parser sentence inline, switches Run and the helpers off, and runs nothing', async () => {
    const calls: string[] = [];
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet(calls)} />);
    type(renderer, 'sum(nope)');
    expect(renderer.root.findByProps({ 'data-analytics-parse-error': '' }).children.join('')).toContain(
      'unknown analytics metric',
    );
    expect(button(renderer, 'Run').props.disabled).toBe(true);
    expect(button(renderer, '7d').props.disabled).toBe(true);
    expect(renderer.root.findAllByType('select').every(select => select.props.disabled)).toBe(true);
    type(renderer, '   ');
    expect(renderer.root.findAllByProps({ 'data-analytics-parse-error': '' })).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it('rewrites the text from the metric, aggregation, range and group helpers', () => {
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet([])} />);
    const [metric, aggregation] = renderer.root.findAllByType('select');
    run(() => metric!.props.onChange({ currentTarget: { value: 'turns' } }));
    expect(input(renderer).props.value).toBe('sum(turns) by (model) [7d]');
    run(() => aggregation!.props.onChange({ currentTarget: { value: 'avg' } }));
    expect(input(renderer).props.value).toBe('avg(turns) by (model) [7d]');
    run(() => button(renderer, '30d').props.onClick());
    expect(input(renderer).props.value).toBe('avg(turns) by (model) [30d]');
    run(() => button(renderer, '30d').props.onClick());
    expect(input(renderer).props.value).toBe('avg(turns) by (model)');
    run(() => button(renderer, 'runtime').props.onClick());
    expect(input(renderer).props.value).toBe('avg(turns) by (model, runtime)');
    run(() => button(renderer, 'model').props.onClick());
    expect(input(renderer).props.value).toBe('avg(turns) by (runtime)');
    run(() => renderer.root.findAllByType('select')[0]!.props.onChange({ currentTarget: { value: '' } }));
    expect(input(renderer).props.value).toBe('avg by (runtime)');
    expect(button(renderer, 'runtime').props['aria-pressed']).toBe(true);
    type(renderer, '{model=a}');
    expect(renderer.root.findAllByType('select')[1]!.props.value).toBe('');
    expect(text(renderer)).toContain('Raw sessions');
  });

  it('runs an example in one click', async () => {
    const calls: string[] = [];
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet(calls)} />);
    const example = ANALYTICS_QUERY_EXAMPLES[2]!;
    await runAsync(async () => {
      renderer.root.findByProps({ title: example.hint }).props.onClick();
      await Promise.resolve();
    });
    await settle();
    expect(calls).toEqual([example.query]);
    expect(input(renderer).props.value).toBe(example.query);
  });

  it('saves, lists, runs and deletes queries, and remembers them in browser storage', async () => {
    const storage = memory();
    const calls: string[] = [];
    const renderer = mount(
      <AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet(calls)} savedStorage={storage} />,
    );
    expect(text(renderer)).toContain('Nothing saved yet');
    const name = renderer.root.findByProps({ placeholder: 'Name this query' });
    const form = renderer.root.findAllByType('form')[1]!;
    expect(button(renderer, 'Save').props.disabled).toBe(true);
    run(() => form.props.onSubmit({ preventDefault() {} }));
    expect(storage.data.has(SAVED_QUERIES_KEY)).toBe(false);
    run(() => name.props.onChange({ currentTarget: { value: 'My cost' } }));
    run(() => form.props.onSubmit({ preventDefault() {} }));
    expect(JSON.parse(storage.data.get(SAVED_QUERIES_KEY)!)).toMatchObject([
      { name: 'My cost', query: ANALYTICS_QUERY_DEFAULT },
    ]);
    expect(name.props.value).toBe('');
    const saved = renderer.root.findByProps({ 'data-analytics-saved-item': 'My cost' });
    await runAsync(async () => {
      saved.findAllByType('button')[0]!.props.onClick();
      await Promise.resolve();
    });
    await settle();
    expect(calls).toEqual([ANALYTICS_QUERY_DEFAULT]);
    run(() => saved.findByProps({ 'aria-label': 'Delete saved query My cost' }).props.onClick());
    expect(text(renderer)).toContain('Nothing saved yet');
    expect(JSON.parse(storage.data.get(SAVED_QUERIES_KEY)!)).toEqual([]);

    const again = mount(
      <AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet([])} savedStorage={storage} />,
    );
    expect(text(again)).toContain('Nothing saved yet');
  });

  it('still renders and works when storage refuses, saying the list will not last', () => {
    const refusing: SavedQueriesStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const renderer = mount(
      <AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet([])} savedStorage={refusing} />,
    );
    expect(text(renderer)).toContain('Saved queries');
    run(() => renderer.root.findByProps({ placeholder: 'Name this query' }).props.onChange({ currentTarget: { value: 'x' } }));
    run(() => renderer.root.findAllByType('form')[1]!.props.onSubmit({ preventDefault() {} }));
    expect(text(renderer)).toContain('would not keep the list');
    expect(renderer.root.findAllByProps({ 'data-analytics-saved-item': 'x' })).toHaveLength(1);
  });

  it('finds label values for autocomplete from the last result, else by asking', async () => {
    const calls: string[] = [];
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet(calls)} />);
    await submit(renderer);
    calls.length = 0;
    const open = async (value: string) => {
      run(() => {
        input(renderer).props.onFocus();
        input(renderer).props.onChange({ currentTarget: { value, selectionStart: value.length } });
      });
      await settle();
    };
    await open('{model=');
    expect(calls).toEqual([]);
    expect(text(renderer)).toContain('gpt-6-astra');
    await open('{harness=');
    expect(calls).toEqual(['count by (harness)']);
  });

  it('answers with an unusable shape as no values', async () => {
    const renderer = mount(
      <AnalyticsQueryPage
        connection={daemonA}
        requestAnalytics={async () => ({ ...answer('x'), kind: 'raw', limit: 1, truncated: false, results: [] }) as never}
      />,
    );
    run(() => {
      input(renderer).props.onFocus();
      input(renderer).props.onChange({ currentTarget: { value: '{status=', selectionStart: 8 } });
    });
    await settle();
    expect(text(renderer)).toContain('Ask any question');
  });

  it('keeps only the newest answer when runs overlap', async () => {
    const resolvers: ((response: AnalyticsResponse) => void)[] = [];
    const renderer = mount(
      <AnalyticsQueryPage
        connection={daemonA}
        requestAnalytics={() => new Promise<AnalyticsResponse>(resolve => resolvers.push(resolve))}
      />,
    );
    await runAsync(async () => {
      renderer.root.findAllByType('form')[0]!.props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    run(() => input(renderer).props.onChange({ currentTarget: { value: 'sum(turns)', selectionStart: 10 } }));
    await runAsync(async () => {
      renderer.root.findAllByType('form')[0]!.props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    await runAsync(async () => {
      resolvers[1]!(answer('sum(turns)'));
      resolvers[0]!(answer('old query'));
      await Promise.resolve();
    });
    await settle();
    expect(input(renderer).props.value).toBe('sum(turns)');
  });

  it('reads through the paired carrier by default', async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(answer('sum by (day)')), { headers: { 'content-type': 'application/json' } });
    }) as never;
    try {
      const renderer = mount(<AnalyticsQueryPage connection={daemonA} initialQuery="sum by (day)" />);
      await settle();
      expect(urls[0]).toContain('/v1/analytics');
      expect(text(renderer)).toContain('claude-opus-5-5');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('AnalyticsQueryPage ratio metric', () => {
  it('offers only sum and avg for a per-turn ratio', () => {
    const renderer = mount(
      <AnalyticsQueryPage connection={daemonA} requestAnalytics={fleet([])} initialQuery={null} />,
    );
    run(() => input(renderer).props.onChange({ currentTarget: { value: 'sum(duration_active_seconds_per_turn)', selectionStart: 5 } }));
    const options = renderer.root.findAllByType('select')[1]!.findAllByType('option');
    expect(options.map(option => [option.props.value, option.props.disabled])).toEqual([
      ['sum', false],
      ['avg', false],
      ['min', true],
      ['max', true],
      ['count', true],
    ]);
  });
});
