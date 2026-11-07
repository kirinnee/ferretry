import { afterEach, describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '../../../../contract/index.ts';
import type { ReactElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ANALYTICS_QUERY_DEFAULT } from '../../../../app/features/analytics/analytics-custom-query.tsx';
import type { FleetAnswer } from '../../../../app/features/analytics/analytics-fanout.ts';
import { ANALYTICS_QUERY_EXAMPLES } from '../../../../app/features/analytics/analytics-query-examples.ts';
import { queryViewPreference } from '../../../../app/features/analytics/analytics-query-view-preference.ts';
import { AnalyticsQueryPage } from '../../../../app/features/analytics/analytics-query-page.tsx';
import {
  SAVED_QUERIES_KEY,
  type SavedQueriesStorage,
} from '../../../../app/features/analytics/analytics-saved-queries.ts';
import { fakeClient } from '../support/client.ts';
import { daemonConnection } from '../support/shell.ts';
import { DaemonResponseError } from '../support/shell.ts';
import { aggregateResponse, group } from '../support/analytics-query-fixtures.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

/** The reads these suites inject are their own; a call that reached this client is a failure. */
const noClient = fakeClient({});

const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  queryViewPreference.write('single');
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
  aggregateResponse(query, [group({ model: 'claude-opus-5-5' }), group({ model: 'gpt-6-astra' }, { sessions: 2 })], {
    groupBy: ['model'],
    metric: 'cost_usd',
  });
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
        connection={daemonA} client={noClient}
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
        connection={daemonA} client={noClient}
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
        connection={daemonA} client={noClient}
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
    expect(text(renderer)).toContain('Insights index is unavailable');
    fail = null;
    await submit(renderer);
    expect(text(renderer)).not.toContain('The query failed');
  });

  it('shows the parser sentence inline, switches Run and the helpers off, and runs nothing', async () => {
    const calls: string[] = [];
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet(calls)} />);
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
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet([])} />);
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
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet(calls)} />);
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
      <AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet(calls)} savedStorage={storage} />,
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
      <AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet([])} savedStorage={storage} />,
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
      <AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet([])} savedStorage={refusing} />,
    );
    expect(text(renderer)).toContain('Saved queries');
    run(() =>
      renderer.root.findByProps({ placeholder: 'Name this query' }).props.onChange({ currentTarget: { value: 'x' } }),
    );
    run(() => renderer.root.findAllByType('form')[1]!.props.onSubmit({ preventDefault() {} }));
    expect(text(renderer)).toContain('would not keep the list');
    expect(renderer.root.findAllByProps({ 'data-analytics-saved-item': 'x' })).toHaveLength(1);
  });

  it('finds label values for autocomplete from the last result, else by asking', async () => {
    const calls: string[] = [];
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet(calls)} />);
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
        connection={daemonA} client={noClient}
        requestAnalytics={async () =>
          ({ ...answer('x'), kind: 'raw', limit: 1, truncated: false, results: [] }) as never
        }
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
        connection={daemonA} client={noClient}
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

  it('names the machines a run missed WITH that run, never over a newer one', async () => {
    const resolvers: ((answer: FleetAnswer) => void)[] = [];
    const missed: FleetAnswer['failed'] = [
      { machine: { connection: daemonB, name: 'kirin-box' }, status: 'failed', error: 'asleep' },
    ];
    const renderer = mount(
      <AnalyticsQueryPage
        connection={daemonA} client={noClient}
        requestAnalytics={fleet([])}
        requestRun={() => new Promise<FleetAnswer>(resolve => resolvers.push(resolve))}
      />,
    );
    const submit = async () =>
      await runAsync(async () => {
        renderer.root.findAllByType('form')[0]!.props.onSubmit({ preventDefault() {} });
        await Promise.resolve();
      });
    await submit();
    await submit();
    await runAsync(async () => {
      resolvers[1]!({ response: answer('new'), failed: [], daemonOf: () => undefined });
      resolvers[0]!({ response: answer('old'), failed: missed, daemonOf: () => undefined });
      await Promise.resolve();
    });
    await settle();
    expect(text(renderer)).not.toContain('did not answer');
    await submit();
    await runAsync(async () => {
      resolvers[2]!({ response: answer('third'), failed: missed, daemonOf: () => undefined });
      await Promise.resolve();
    });
    await settle();
    expect(text(renderer)).toContain('kirin-box did not answer: asleep. Its sessions are not in this result.');
  });

  it('asks the answer on screen again when the reader changes the time zone', async () => {
    const asked: Array<string | undefined> = [];
    const requestRun = async (query: string | undefined): Promise<FleetAnswer> => {
      asked.push(query);
      return { response: answer(query ?? 'sum by (day)'), failed: [], daemonOf: () => undefined };
    };
    const page = (timeZone: string) => (
      <AnalyticsQueryPage
        connection={daemonA} client={noClient}
        requestAnalytics={fleet([])}
        requestRun={requestRun}
        timeZone={timeZone}
        initialQuery="sum by (day)"
      />
    );
    const renderer = mount(page('UTC'));
    await settle();
    expect(asked).toEqual(['sum by (day)']);

    await runAsync(async () => {
      renderer.update(page('Asia/Singapore'));
      await Promise.resolve();
    });
    await settle();
    expect(asked).toEqual(['sum by (day)', 'sum by (day)']);

    // The same zone again is not a change.
    await runAsync(async () => {
      renderer.update(page('Asia/Singapore'));
      await Promise.resolve();
    });
    await settle();
    expect(asked).toHaveLength(2);
  });

  it('never shows a stale zone’s answer when the zone changes while the first run is pending', async () => {
    // Arrange — each zone's requests are held until the test settles them
    const asked: Array<{ zone: string; query: string | undefined; settle: () => void }> = [];
    const requestRunIn =
      (zone: string) =>
      (query: string | undefined): Promise<FleetAnswer> =>
        new Promise(resolve => {
          const response = aggregateResponse(query ?? 'sum by (day)', [group({ model: `${zone}-model` })], {
            groupBy: ['model'],
            metric: 'cost_usd',
          });
          asked.push({
            zone,
            query,
            settle: () => resolve({ response, failed: [], daemonOf: () => undefined }),
          });
        });
    const page = (zone: string) => (
      <AnalyticsQueryPage
        connection={daemonA} client={noClient}
        requestAnalytics={fleet([])}
        requestRun={requestRunIn(zone)}
        timeZone={zone}
        initialQuery="sum by (day)"
      />
    );
    const renderer = mount(page('UTC'));
    await settle();
    expect(asked.map(call => call.zone)).toEqual(['UTC']);

    // Act — the zone changes while the first query is still unanswered
    await runAsync(async () => {
      renderer.update(page('Asia/Singapore'));
      await Promise.resolve();
    });
    await settle();

    // Assert — the new zone is asked the same query
    expect(asked.map(call => [call.zone, call.query])).toEqual([
      ['UTC', 'sum by (day)'],
      ['Asia/Singapore', 'sum by (day)'],
    ]);

    // The old zone's answer arrives late and is dropped; the new zone's is the one shown.
    await runAsync(async () => {
      asked[0]!.settle();
      await Promise.resolve();
    });
    await settle();
    expect(text(renderer)).not.toContain('UTC-model');
    await runAsync(async () => {
      asked[1]!.settle();
      await Promise.resolve();
    });
    await settle();
    expect(text(renderer)).toContain('Asia/Singapore-model');
    expect(text(renderer)).not.toContain('UTC-model');
  });

  it('asks nothing on a zone change when no query was ever submitted', async () => {
    const asked: Array<string | undefined> = [];
    const requestRun = async (query: string | undefined): Promise<FleetAnswer> => {
      asked.push(query);
      return { response: answer(query ?? 'sum by (day)'), failed: [], daemonOf: () => undefined };
    };
    const page = (timeZone: string) => (
      <AnalyticsQueryPage
        connection={daemonA} client={noClient}
        requestAnalytics={fleet([])}
        requestRun={requestRun}
        timeZone={timeZone}
      />
    );
    const renderer = mount(page('UTC'));
    await settle();
    await runAsync(async () => {
      renderer.update(page('Asia/Singapore'));
      await Promise.resolve();
    });
    await settle();
    expect(asked).toEqual([]);
  });

  describe('single result or trend', () => {
    const choose = async (renderer: ReactTestRenderer, group: string, segment: string) => {
      const target = renderer.root
        .findByProps({ 'data-segmented': group })
        .find(node => node.type === 'button' && node.props['data-segment'] === segment);
      await runAsync(async () => {
        target.props.onClick();
        await Promise.resolve();
      });
      await settle();
    };
    const asking =
      (asked: string[]) =>
      async (query: string | undefined): Promise<FleetAnswer> => {
        asked.push(query ?? '');
        return { response: answer(query ?? ''), failed: [], daemonOf: () => undefined };
      };

    it('asks the text as written in Single, and the same question by day in Trend, keeping the reader\u2019s text', async () => {
      const asked: string[] = [];
      const renderer = mount(
        <AnalyticsQueryPage
          connection={daemonA} client={noClient}
          requestAnalytics={fleet([])}
          requestRun={asking(asked)}
          initialQuery="sum(cost_usd) by (model) [7d]"
        />,
      );
      await settle();
      expect(asked).toEqual(['sum(cost_usd) by (model) [7d]']);

      await choose(renderer, 'analytics-result-view', 'trend');
      expect(asked.at(-1)).toBe('sum(cost_usd) by (model, day) [7d]');
      // The editor still holds the reader\u2019s own query, not the derived one.
      expect(input(renderer).props.value).toBe('sum(cost_usd) by (model) [7d]');

      await choose(renderer, 'analytics-trend-bucket', 'week');
      expect(asked.at(-1)).toBe('sum(cost_usd) by (model, week) [7d]');

      await choose(renderer, 'analytics-result-view', 'single');
      expect(asked.at(-1)).toBe('sum(cost_usd) by (model) [7d]');
      expect(asked).toHaveLength(4);
    });

    it('keeps an unsubmitted draft when the view or bucket changes, and asks the submitted query again', async () => {
      const asked: string[] = [];
      const renderer = mount(
        <AnalyticsQueryPage
          connection={daemonA} client={noClient}
          requestAnalytics={fleet([])}
          requestRun={asking(asked)}
          initialQuery="sum(tokens) [7d]"
        />,
      );
      await settle();
      expect(asked).toEqual(['sum(tokens) [7d]']);

      type(renderer, 'sum(turns) [30d]');
      await choose(renderer, 'analytics-result-view', 'trend');
      expect(asked.at(-1)).toBe('sum(tokens) by (day) [7d]');
      expect(input(renderer).props.value).toBe('sum(turns) [30d]');

      await choose(renderer, 'analytics-trend-bucket', 'week');
      expect(asked.at(-1)).toBe('sum(tokens) by (week) [7d]');
      expect(input(renderer).props.value).toBe('sum(turns) [30d]');

      // Submitting the draft is what makes it the query that is asked.
      await submit(renderer);
      expect(asked.at(-1)).toBe('sum(turns) by (week) [30d]');
      expect(input(renderer).props.value).toBe('sum(turns) [30d]');
    });

    it('keeps the choice on this device', async () => {
      const first = mount(
        <AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet([])} requestRun={asking([])} />,
      );
      await choose(first, 'analytics-result-view', 'trend');
      expect(queryViewPreference.read()).toBe('trend');
      const second = mount(
        <AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet([])} requestRun={asking([])} />,
      );
      const pressed = second.root
        .findByProps({ 'data-segmented': 'analytics-result-view' })
        .findAll(node => node.type === 'button' && node.props['aria-pressed'] === true);
      expect(pressed.map(node => node.props['data-segment'])).toEqual(['trend']);
    });

    it('says when a window was added, and why there is no trend when there is none, without calling it a failure', async () => {
      queryViewPreference.write('trend');
      const asked: string[] = [];
      const renderer = mount(
        <AnalyticsQueryPage
          connection={daemonA} client={noClient}
          requestAnalytics={fleet([])}
          requestRun={asking(asked)}
          initialQuery="sum(tokens)"
        />,
      );
      await settle();
      expect(asked).toEqual(['sum(tokens) by (day) [30d]']);
      expect(text(renderer)).toContain('No range was given, so this trend covers the last 30d');

      type(renderer, 'cost_usd [7d]');
      await submit(renderer);
      expect(asked).toHaveLength(1);
      expect(text(renderer)).toContain('A trend needs a total to follow');
      expect(text(renderer)).not.toContain('The query failed');
    });

    it('re-asks an empty query when the view changes: empty is a query that was run, not a page that never ran', async () => {
      const asked: string[] = [];
      const renderer = mount(
        <AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet([])} requestRun={asking(asked)} />,
      );
      type(renderer, '');
      await submit(renderer);
      expect(asked).toEqual(['']);

      await choose(renderer, 'analytics-result-view', 'trend');
      // The blank query is the protocol's default, which already groups by day.
      expect(asked).toEqual(['', 'sum by (day) [30d]']);
      await choose(renderer, 'analytics-result-view', 'single');
      expect(asked).toEqual(['', 'sum by (day) [30d]', 'sum by (day)']);
    });

    const bucketButton = (renderer: ReactTestRenderer, segment: string) =>
      renderer.root
        .findByProps({ 'data-segmented': 'analytics-trend-bucket' })
        .find(node => node.type === 'button' && node.props['data-segment'] === segment);

    it('shows the day or week a query groups by as the chosen bucket and does not offer the other', async () => {
      queryViewPreference.write('trend');
      const asked: string[] = [];
      const renderer = mount(
        <AnalyticsQueryPage
          connection={daemonA} client={noClient}
          requestAnalytics={fleet([])}
          requestRun={asking(asked)}
          initialQuery="sum(turns) by (day) [7d]"
        />,
      );
      await settle();
      expect(asked).toEqual(['sum(turns) by (day) [7d]']);
      expect(bucketButton(renderer, 'day').props['aria-pressed']).toBe(true);
      expect(bucketButton(renderer, 'week').props).toMatchObject({
        'aria-pressed': false,
        disabled: true,
        title: 'The query groups by day itself',
      });
      expect(bucketButton(renderer, 'day').props.disabled).toBeUndefined();
      expect(text(renderer)).toContain('The query groups by day itself.');

      // The control follows the SUBMITTED query, so a draft being typed neither unlocks it ...
      type(renderer, 'sum(turns) [7d]');
      expect(bucketButton(renderer, 'week').props.disabled).toBe(true);
      expect(text(renderer)).toContain('The query groups by day itself.');

      // ... nor does it lock it the other way: only submitting changes what the control describes.
      await submit(renderer);
      expect(bucketButton(renderer, 'week').props.disabled).toBeUndefined();
      expect(bucketButton(renderer, 'day').props['aria-pressed']).toBe(true);
      expect(text(renderer)).not.toContain('groups by day itself');
    });

    it('keeps the bucket control and the request in agreement while a different draft is being typed', async () => {
      queryViewPreference.write('trend');
      const asked: string[] = [];
      const renderer = mount(
        <AnalyticsQueryPage
          connection={daemonA} client={noClient}
          requestAnalytics={fleet([])}
          requestRun={asking(asked)}
          initialQuery="sum(turns) [7d]"
        />,
      );
      await settle();
      type(renderer, 'sum(tokens) by (day) [30d]');
      // The draft names its own bucket, but it is not what a rerun asks, so the control stays the reader's.
      expect(bucketButton(renderer, 'week').props.disabled).toBeUndefined();
      expect(text(renderer)).not.toContain('groups by day itself');

      await choose(renderer, 'analytics-trend-bucket', 'week');
      expect(asked.at(-1)).toBe('sum(turns) by (week) [7d]');
      expect(bucketButton(renderer, 'week').props['aria-pressed']).toBe(true);
      expect(bucketButton(renderer, 'day').props['aria-pressed']).toBe(false);
      expect(input(renderer).props.value).toBe('sum(tokens) by (day) [30d]');
    });
  });

  it('reads through the daemon client by default', async () => {
    const client = fakeClient({ 'GET /v1/usage/insights': answer('sum by (day)') });
    const renderer = mount(<AnalyticsQueryPage connection={daemonA} client={client} initialQuery="sum by (day)" />);
    await settle();
    expect(client.calls.map(call => call.route)).toEqual(['GET /v1/usage/insights']);
    expect(client.calls[0]?.query).toEqual({ q: 'sum by (day)' });
    expect(text(renderer)).toContain('claude-opus-5-5');
  });
});

describe('AnalyticsQueryPage ratio metric', () => {
  it('offers only sum and avg for a per-turn ratio', () => {
    const renderer = mount(
      <AnalyticsQueryPage connection={daemonA} client={noClient} requestAnalytics={fleet([])} initialQuery={null} />,
    );
    run(() =>
      input(renderer).props.onChange({
        currentTarget: { value: 'sum(duration_active_seconds_per_turn)', selectionStart: 5 },
      }),
    );
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
