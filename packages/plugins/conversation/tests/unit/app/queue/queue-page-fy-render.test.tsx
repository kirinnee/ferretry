/**
 * r12 H7 fix 2 — a queued message in the Queue panel, on BOTH screens that draw a queue.
 *
 * The base reader of a queued message was the shell's `Markdown` over the surface the screen sits in (`ChatProse`), which
 * is still exactly what `Markdown` + that surface is. So "the base behaviour" is proved by DOM comparison against
 * `Markdown` itself: a location block and a plain `terminal` fence draw the same DOM the base drew, in the per-ferret
 * panel (which inherits the chat surface and its fence door) and on the standalone All-queues screen (no door). The one
 * addition is the live `fy-render` chart, which the per-ferret panel draws and All-queues keeps as code.
 */
import { describe, expect, it } from 'bun:test';
import { formatLocationBlock, Markdown, ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { QueuePageView, type QueueRowHandlers } from '../../../../app/queue/queue-page.tsx';
import { queueSegments } from '../../../../app/queue/queue-prose.tsx';
import { queueRowOf } from '../../../../app/queue/queue-view.ts';
import { fyRenderFences } from '../../../../app/render/fences.tsx';
import { FENCE, installFyRenderDom } from '../hypermedia/fy-render-draw.tsx';
import { fixture, inShell } from '../hypermedia/surface-fixture.tsx';

installFyRenderDom();

const CHART = [
  `${FENCE}fy-render`,
  'type: chart',
  'alt: Spend per day',
  '---',
  'kind: bar',
  'series: [{name: A, data: [1, 2]}]',
  FENCE,
].join('\n');

const LOCATION = formatLocationBlock({
  latitude: 51.50735,
  longitude: -0.12776,
  accuracyMeters: 20,
  capturedAt: Date.parse('2026-10-21T12:00:00.000Z'),
  place: 'Home',
});

const TERMINAL = [`${FENCE}terminal`, '$ bun test', 'ok', FENCE].join('\n');

const handlers: QueueRowHandlers = { edit: async () => undefined, cancel: async () => undefined };

/** The surface the per-ferret panel inherits from the chat (with the fence door), or the one All-queues has (without). */
const surfaceOf = (withDoor: boolean) => {
  const { surface } = fixture();
  return withDoor ? { ...surface, fences: fyRenderFences() } : surface;
};

const panel = async (text: string, withDoor: boolean) => {
  const row = queueRowOf('d1', 's1', 'Casen', {
    id: 'q1',
    sender: 'agent',
    text,
    state: 'queued',
    enqueuedAt: '2026-10-30T10:00:01.000Z',
    revision: 1,
    by: { kind: 'ferret', name: 'Mira' },
  } as never);
  const view = (
    <QueuePageView
      groups={[{ key: 'd1/s1', daemonId: 'd1', machine: 'Laptop', ferretId: 's1', ferret: 'Casen', rows: [row] }]}
      handlers={handlers}
      loading={false}
      onOpenFerret={() => undefined}
      showMachine={false}
      title="Queue — Casen"
    />
  );
  const tree = inShell(
    <ReferenceSurfaceProvider surface={surfaceOf(withDoor)}>{view}</ReferenceSurfaceProvider>,
  ) as ReactNode;
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

/** What the base drew for `text`: the shell's Markdown over the same surface (a fence door is Markdown's no business). */
const baseDom = async (text: string, withDoor: boolean): Promise<string> => {
  const { fences: _door, ...surface } = surfaceOf(withDoor);
  const { container, unmount } = await mount(
    inShell(
      <ReferenceSurfaceProvider surface={surfaceOf(withDoor)}>
        <Markdown text={text} {...surface} />
      </ReferenceSurfaceProvider>,
    ) as never,
  );
  await interact(() => Promise.resolve());
  const html = container.innerHTML;
  await unmount();
  return html;
};

const bodyDom = async (text: string, withDoor: boolean): Promise<string> => {
  const { container, unmount } = await panel(text, withDoor);
  const html = container.querySelector('[data-queue-body]')?.innerHTML ?? '';
  await unmount();
  return html;
};

describe('the Queue panel draws a queued message as the base did', () => {
  for (const [name, text] of [
    ['a location block', LOCATION],
    ['a plain terminal fence', TERMINAL],
    ['prose around both', `Where I am:\n\n${LOCATION}\n\nand the run:\n\n${TERMINAL}\n\ndone.`],
  ] as const) {
    for (const [screen, withDoor] of [
      ['per-ferret panel', true],
      ['All queues', false],
    ] as const) {
      it(`${name}: the ${screen} DOM equals the shell Markdown's`, async () => {
        const expected = await baseDom(text, withDoor);
        expect(expected.length).toBeGreaterThan(0);
        expect(await bodyDom(text, withDoor)).toBe(expected);
      });
    }
  }

  it('shows the location chip and the terminal code block on both screens, not a Durian part', async () => {
    for (const withDoor of [true, false]) {
      const { container, unmount } = await panel(`${LOCATION}\n\n${TERMINAL}`, withDoor);
      const body = container.querySelector('[data-queue-body]') as HTMLElement;
      expect(body.querySelector('pre > code')).not.toBeNull();
      expect(body.textContent).toContain('$ bun test');
      expect(body.querySelector('[data-fy-hypermedia]')).toBeNull();
      await unmount();
    }
  });
});

describe('the per-ferret Queue panel', () => {
  it('draws a queued fy-render chart live, not as pre > code', async () => {
    const { container, unmount } = await panel(CHART, true);
    expect(container.querySelectorAll('[data-queue-body] [data-fy-render-type="chart"]').length).toBe(1);
    expect(container.querySelectorAll('[data-queue-body] pre > code').length).toBe(0);
    await unmount();
  });

  it('draws the chart AND keeps the location chip and terminal code of the same message', async () => {
    const { container, unmount } = await panel(`${LOCATION}\n\n${CHART}\n\n${TERMINAL}`, true);
    const body = container.querySelector('[data-queue-body]') as HTMLElement;
    expect(body.querySelectorAll('[data-fy-render-type="chart"]').length).toBe(1);
    expect(body.querySelectorAll('pre > code').length).toBe(1);
    expect(body.textContent).toContain('$ bun test');
    // The Markdown run before the chart draws what the base drew for it (the location chip).
    expect(body.innerHTML.startsWith(await baseDom(LOCATION, true))).toBe(true);
    await unmount();
  });
});

describe('the standalone All-queues screen', () => {
  it('keeps the chart as code where the surface lends no fence door', async () => {
    const { container, unmount } = await panel(CHART, false);
    expect(container.querySelectorAll('[data-fy-render-type]').length).toBe(0);
    expect(container.querySelectorAll('[data-queue-body] pre code').length).toBe(1);
    expect(await bodyDom(CHART, false)).toBe(await baseDom(CHART, false));
    await unmount();
  });
});

describe('queueSegments', () => {
  it('cuts a message at its closed top-level fy-render fences only', () => {
    expect(queueSegments(`a\n\n${CHART}\n\nb`).map(segment => segment.kind)).toEqual(['markdown', 'fence', 'markdown']);
    expect(queueSegments(TERMINAL).map(segment => segment.kind)).toEqual(['markdown']);
    expect(queueSegments(`${FENCE}fy-render\ntype: chart`).map(segment => segment.kind)).toEqual(['markdown']);
    expect(queueSegments(`- item\n\n  ${CHART.split('\n').join('\n  ')}`).map(segment => segment.kind)).toEqual([
      'markdown',
    ]);
  });
});
