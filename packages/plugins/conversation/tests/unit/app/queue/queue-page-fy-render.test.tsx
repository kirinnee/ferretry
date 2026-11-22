/**
 * r12 H7 fix — the per-ferret Queue panel draws a queued `fy-render` block live, as it did before H7: a queued message
 * is read by `HypermediaProse` over the chat's reference surface (its `fences`), never as `pre > code`. The probe is the
 * reviewer's: a queued chart draws a `[data-fy-render-type="chart"]` block, not a code fence.
 */
import { describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { QueuePageView, type QueueRowHandlers } from '../../../../app/queue/queue-page.tsx';
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

const handlers: QueueRowHandlers = { edit: async () => undefined, cancel: async () => undefined };

const panel = async (text: string, withSurface: boolean) => {
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
  const f = fixture();
  const tree = withSurface
    ? (inShell(
        <ReferenceSurfaceProvider surface={{ ...f.surface, fences: fyRenderFences() }}>
          {view}
        </ReferenceSurfaceProvider>,
      ) as ReactNode)
    : (inShell(view) as ReactNode);
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

describe('the per-ferret Queue panel', () => {
  it('draws a queued fy-render chart live, not as pre > code', async () => {
    const { container, unmount } = await panel(CHART, true);
    expect(container.querySelectorAll('[data-queue-body] [data-fy-render-type="chart"]').length).toBe(1);
    expect(container.querySelectorAll('[data-queue-body] pre > code').length).toBe(0);
    await unmount();
  });

  it('keeps the block as code where the surface lends no fence door (the standalone All-queues screen)', async () => {
    const { container, unmount } = await panel(CHART, false);
    expect(container.querySelectorAll('[data-fy-render-type]').length).toBe(0);
    expect(container.querySelectorAll('[data-queue-body] pre code').length).toBe(1);
    await unmount();
  });
});
