import { describe, expect, test } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { CiRun } from '../../../contract/wire.ts';
import type { CiClient } from '../../../app/features/ci-run/ci-api.ts';
import { CiRunPage } from '../../../app/features/ci-run/ci-run-page.tsx';
import { BIG_RUN, CANCELLED_RUN, secondsAfterT0 } from '../../fixtures/flame-runs.ts';

const SCOPE = { project: '11111111-1111-4111-8111-111111111111', repo: { owner: 'octo', name: 'hello' } };

const page = (run: CiRun, nowMs: number) => {
  const client: CiClient = { call: (async () => run) as CiClient['call'] };
  return (
    <RouterProvider>
      <CiRunPage client={client} scope={SCOPE} runId={run.id} nowMs={nowMs} />
    </RouterProvider>
  );
};

const shown = async (mounted: Mounted): Promise<void> =>
  await settleUntil(() => mounted.container.querySelector('[data-ci-run-page]') !== null, 'the run', interact);

const click = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
};

const count = (mounted: Mounted, selector: string): number => mounted.container.querySelectorAll(selector).length;

/** The most the contract allows (256 jobs x 500 steps), every job failed: the worst case for what opens by itself. */
const worst = (): CiRun => {
  const run = BIG_RUN();
  return { ...run, jobs: run.jobs.map(job => ({ ...job, status: 'failed' as const })) };
};

describe('the biggest run the contract allows', () => {
  test('mounts a bounded few rows, however many jobs failed and however many steps they have', async () => {
    const mounted = await mount(page(worst(), secondsAfterT0(20_000)));
    await shown(mounted);
    // Every job is reachable (its header is a button), but only the first four open by themselves, 25 steps each.
    expect(count(mounted, '[data-ci-job]')).toBe(256);
    expect(count(mounted, '[data-ci-job] > div button[aria-expanded]')).toBe(256);
    expect(count(mounted, '[data-ci-job] button[aria-expanded="true"]')).toBe(4);
    expect(count(mounted, '[data-ci-step]')).toBe(100);
    expect(mounted.container.querySelector('[data-ci-shut-jobs]')?.textContent).toBe(
      '252 more jobs need a look: only the first 4 open by themselves.',
    );
    // The rest of each open job is said in words and reachable by its button.
    const more = must(mounted.container.querySelector('[data-ci-more-steps]'), 'the more-steps line');
    expect(more.textContent).toContain('Showing 25 of 500 steps');
    expect(more.textContent).toContain('Show 25 more');
  });

  test('"Show more" doubles what is drawn, and a shut job opens on its own button', async () => {
    const mounted = await mount(page(worst(), secondsAfterT0(20_000)));
    await shown(mounted);
    const first = must(mounted.container.querySelector<HTMLElement>('[data-ci-job="1"]'), 'job 1');
    await click(must(first.querySelector('[data-ci-more-steps] button'), 'show more'));
    expect(first.querySelectorAll('[data-ci-step]').length).toBe(50);
    await click(must(first.querySelector('[data-ci-more-steps] button'), 'show more'));
    expect(first.querySelectorAll('[data-ci-step]').length).toBe(100);
    expect(first.querySelector('[data-ci-more-steps]')?.textContent).toContain('Showing 100 of 500 steps');
    // Keep asking and every step is there.
    for (let round = 0; round < 3; round += 1)
      await click(must(first.querySelector('[data-ci-more-steps] button'), 'show more'));
    expect(first.querySelectorAll('[data-ci-step]').length).toBe(500);
    expect(first.querySelector('[data-ci-more-steps]')).toBeNull();
    // A job that did not open by itself opens, again with its first page only.
    const fifth = must(mounted.container.querySelector<HTMLElement>('[data-ci-job="5"]'), 'job 5');
    expect(fifth.querySelectorAll('[data-ci-step]').length).toBe(0);
    await click(must(fifth.querySelector('button'), 'job 5 header'));
    expect(fifth.querySelectorAll('[data-ci-step]').length).toBe(25);
  });

  test('the step the header names as slowest is drawn even when it is past the first page', async () => {
    const run = BIG_RUN(3, 100);
    const slow = {
      ...run,
      jobs: run.jobs.map(job =>
        job.id === 1
          ? {
              ...job,
              status: 'failed' as const,
              steps: job.steps.map(step =>
                step.number === 80 && step.start !== undefined
                  ? { ...step, end: new Date(Date.parse(step.start) + 600_000).toISOString() }
                  : step,
              ),
            }
          : job,
      ),
    };
    const mounted = await mount(page(slow, secondsAfterT0(20_000)));
    await shown(mounted);
    const first = must(mounted.container.querySelector<HTMLElement>('[data-ci-job="1"]'), 'job 1');
    expect(mounted.container.querySelector('[data-ci-slowest-line]')?.textContent).toBe(
      'Slowest step: step 80 in job 1, 10m 00s',
    );
    expect(first.querySelectorAll('[data-ci-step]').length).toBe(26);
    expect(first.querySelector('[data-ci-step="80"]')?.getAttribute('data-ci-slowest')).toBe('true');
    expect(first.querySelector('[data-ci-more-steps]')?.textContent).toContain('Showing 26 of 100 steps');
  });
});

describe('one clock', () => {
  const seconds = (mounted: Mounted, job: string, step: string): string | null =>
    must(
      mounted.container.querySelector(`[data-ci-job="${job}"] [data-ci-step="${step}"] [data-ci-duration]`),
      'duration',
    ).textContent;

  test('a "live" step inside a job that stopped keeps E8’s end: label and bar do not grow with the browser clock', async () => {
    const early = await mount(page(CANCELLED_RUN, secondsAfterT0(12)));
    const hourLater = await mount(page(CANCELLED_RUN, secondsAfterT0(12 + 3_600)));
    await shown(early);
    await shown(hourLater);
    for (const mounted of [early, hourLater]) {
      // A cancelled job is shut until asked.
      await click(must(mounted.container.querySelector('[data-ci-job="8"] button'), 'the job header'));
      expect(seconds(mounted, '8', '2')).toBe('9s');
      expect(
        mounted.container
          .querySelector('[data-ci-job="8"] [data-ci-step="2"] [data-ci-duration]')
          ?.getAttribute('data-ci-duration'),
      ).toBe('done');
    }
    const width = (mounted: Mounted): string | undefined =>
      mounted.container
        .querySelector<HTMLElement>('[data-ci-job="8"] [data-ci-step="2"] [style]')
        ?.getAttribute('style') ?? undefined;
    expect(width(early)).toBe(width(hourLater));
    expect(width(early)).toContain('width: 90%');
    expect(early.container.textContent).not.toContain('Live');
  });

  test('a step ticks to the clock only while its job and its run are live too, label and bar together', async () => {
    const run: CiRun = {
      id: 9100,
      name: 'CI',
      status: 'running',
      trigger: 'push',
      attempt: 1,
      headSha: 'a'.repeat(40),
      createdAt: new Date(secondsAfterT0(0)).toISOString(),
      start: new Date(secondsAfterT0(0)).toISOString(),
      queuedMs: 0,
      wallMs: 1_000,
      live: true,
      jobs: [
        {
          id: 1,
          name: 'test',
          status: 'running',
          queuedMs: 0,
          start: new Date(secondsAfterT0(0)).toISOString(),
          end: new Date(secondsAfterT0(1)).toISOString(),
          live: true,
          steps: [
            {
              name: 'Unit tests',
              number: 1,
              status: 'running',
              start: new Date(secondsAfterT0(0)).toISOString(),
              end: new Date(secondsAfterT0(1)).toISOString(),
              live: true,
            },
          ],
        },
      ],
    };
    const mounted = await mount(page(run, secondsAfterT0(61)));
    await shown(mounted);
    expect(seconds(mounted, '1', '1')).toBe('1m 01slive');
    expect(mounted.container.querySelector('[data-ci-job="1"]')?.textContent).toContain('1m 01s');
    expect(
      mounted.container.querySelector('[data-ci-job="1"] [data-ci-step="1"] [style]')?.getAttribute('style'),
    ).toContain('width: 100%');
  });
});
