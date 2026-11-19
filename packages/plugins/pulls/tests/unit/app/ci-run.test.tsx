import { describe, expect, test } from 'bun:test';
import { ScreenHrefProvider } from '@ferretry/app';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { CiRun } from '../../../contract/wire.ts';
import { RUN_ROUTE, RUNS_ROUTE, type CiClient } from '../../../app/features/ci-run/ci-api.ts';
import { CiRunPage } from '../../../app/features/ci-run/ci-run-page.tsx';
import { CiTab } from '../../../app/features/ci-run/ci-runs-list.tsx';
import { checkRun, failedRun, NOW, passingRun, runningRun } from '../../fixtures/ci-run-views.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SCOPE = { project: PROJECT, repo: { owner: 'octo', name: 'hello' } };

interface Call {
  readonly route: string;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly query: Readonly<Record<string, string>> | undefined;
}

const client = (answers: Readonly<Record<string, unknown>>, calls: Call[] = []): CiClient => ({
  call: async <Answer,>(
    route: string,
    init?: { params?: Readonly<Record<string, string>>; query?: Readonly<Record<string, string>> },
  ): Promise<Answer> => {
    calls.push({ route, params: init?.params, query: init?.query });
    const answer = answers[route];
    if (answer instanceof Error) throw answer;
    return answer as Answer;
  },
});

const href = (_daemon: string, plugin: string, screen: string, params: Readonly<Record<string, string>> = {}) =>
  `/d/${plugin}/${screen}/${params.runId ?? ''}`;

const page = (c: CiClient, nowMs = NOW) => (
  <RouterProvider>
    <CiRunPage client={c} scope={SCOPE} runId={1} nowMs={nowMs} />
  </RouterProvider>
);

const tab = (c: CiClient) => (
  <RouterProvider>
    <ScreenHrefProvider href={href}>
      <CiTab client={c} daemon="workstation" scope={SCOPE} target={{ pr: 7 }} nowMs={NOW} />
    </ScreenHrefProvider>
  </RouterProvider>
);

const shown = async (mounted: Mounted, selector: string): Promise<void> =>
  await settleUntil(() => mounted.container.querySelector(selector) !== null, selector, interact);

const click = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
};

const job = (mounted: Mounted, name: string): HTMLElement =>
  must(
    [...mounted.container.querySelectorAll<HTMLElement>('[data-ci-job]')].find(el =>
      (el.textContent ?? '').includes(name),
    ),
    `job ${name}`,
  );

describe('CiRunPage', () => {
  test('a passing run: totals, queue, slowest step, jobs shut, logs link per job', async () => {
    const run = passingRun();
    const calls: Call[] = [];
    const mounted = await mount(page(client({ [RUN_ROUTE]: run }, calls)));
    await shown(mounted, '[data-ci-run-page]');
    expect(calls[0]?.params).toEqual({ project: PROJECT, repo: 'octo~hello', runId: '1' });
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Passed');
    expect(text).toContain('Pull request');
    expect(text).toContain('Slowest step: Unit tests in test (ubuntu), 3m 56s');
    expect(mounted.container.querySelectorAll('[data-ci-job]').length).toBe(3);
    // No job failed or runs: every job is shut, so no step is drawn yet.
    expect(mounted.container.querySelectorAll('[data-ci-step]').length).toBe(0);
    const logs = [...mounted.container.querySelectorAll<HTMLAnchorElement>('a')].filter(a =>
      (a.textContent ?? '').includes('Logs'),
    );
    expect(logs.length).toBe(3);
    expect(logs[0]?.getAttribute('rel')).toContain('noopener');
    expect(logs[0]?.textContent).toContain('for lint');
  });

  test('opening a job shows its steps with durations and marks the slowest once', async () => {
    const mounted = await mount(page(client({ [RUN_ROUTE]: passingRun() })));
    await shown(mounted, '[data-ci-run-page]');
    const section = job(mounted, 'test (ubuntu)');
    const toggle = must(section.querySelector('button'), 'the job button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = section.querySelectorAll('[data-ci-step]');
    expect(rows.length).toBe(6);
    const unit = must(section.querySelector('[data-ci-step="4"]'), 'the Unit tests step');
    expect(unit.textContent).toContain('3m 56s');
    expect(unit.getAttribute('data-ci-slowest')).toBe('true');
    expect(mounted.container.querySelectorAll('[data-ci-slowest="true"]').length).toBe(1);
    expect(section.textContent).toContain('Waited 14s to start');
    await click(toggle);
    expect(section.querySelectorAll('[data-ci-step]').length).toBe(0);
  });

  test('a failed run opens the failed job by itself and skipped steps have no bar', async () => {
    const mounted = await mount(page(client({ [RUN_ROUTE]: failedRun() })));
    await shown(mounted, '[data-ci-run-page]');
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Failed');
    expect(text).toContain('Attempt 2');
    const failed = job(mounted, 'test (ubuntu)');
    expect(failed.getAttribute('data-ci-job-status')).toBe('failed');
    expect(failed.querySelectorAll('[data-ci-step]').length).toBe(4);
    expect(job(mounted, 'lint').querySelectorAll('[data-ci-step]').length).toBe(0);
    const skipped = must(failed.querySelector('[data-ci-step="4"]'), 'the skipped step');
    expect(skipped.textContent).toContain('skipped');
    expect(skipped.querySelector('[style]')).toBeNull();
    expect(failed.querySelector('[data-ci-step="3"] [style]')).not.toBeNull();
  });

  test('a running run counts up from the clock it is given, not from the daemon’s last answer', async () => {
    const run = runningRun();
    const early = await mount(page(client({ [RUN_ROUTE]: run }), NOW));
    await shown(early, '[data-ci-run-page]');
    const running = job(early, 'test (ubuntu)');
    expect(running.querySelector('[data-ci-step="3"] [data-ci-duration]')?.getAttribute('data-ci-duration')).toBe(
      'live',
    );
    const at = (mounted: Mounted) =>
      must(job(mounted, 'test (ubuntu)').querySelector('[data-ci-step="3"] [data-ci-duration]'), 'duration')
        .textContent;
    const later = await mount(page(client({ [RUN_ROUTE]: run }), NOW + 30_000));
    await shown(later, '[data-ci-run-page]');
    expect(at(early)).toBe('5m 40slive');
    expect(at(later)).toBe('6m 10slive');
    expect(job(early, 'deploy preview').textContent).toContain('Queued');
    // Live says so, no step is named "slowest" while one is still running, and a job that has not started has no logs to open.
    expect(early.container.textContent).toContain('Live');
    expect(early.container.querySelector('[data-ci-slowest-line]')).toBeNull();
    expect(job(early, 'deploy preview').querySelector('a')).toBeNull();
    expect(job(early, 'lint').querySelector('a')).not.toBeNull();
  });

  test('a CI with no jobs says so instead of drawing an empty list', async () => {
    const mounted = await mount(page(client({ [RUN_ROUTE]: checkRun() })));
    await shown(mounted, '[data-ci-run-page]');
    expect(mounted.container.textContent).toContain('a single check, not jobs and steps');
    // Queue wait and the job count mean nothing without jobs.
    expect(mounted.container.textContent).not.toContain('Queue wait');
  });

  test('a refused read says the daemon’s words; a budget pause says until when, once', async () => {
    const refused = await mount(page(client({ [RUN_ROUTE]: new Error('that run is not on this repository') })));
    await shown(refused, '[data-ci-failed]');
    expect(refused.container.textContent).toContain('that run is not on this repository');
    const paused = Object.assign(new Error('paused'), { body: { pausedUntil: '2026-11-19T10:30:00Z' } });
    const mounted = await mount(page(client({ [RUN_ROUTE]: paused })));
    await shown(mounted, '[data-ci-failed]');
    expect(mounted.container.textContent).toMatch(/Paused until .+ to stay inside GitHub's limit/u);
    // Asking again while paused is pointless: no button.
    expect(mounted.container.querySelector('button')).toBeNull();
    expect(refused.container.querySelector('button')).not.toBeNull();
  });
});

describe('Try again', () => {
  test('a refused read can be asked again and then shows the run', async () => {
    let answered = 0;
    const flaky: CiClient = {
      call: (async () => {
        answered += 1;
        if (answered === 1) throw new Error('GitHub did not answer');
        return passingRun();
      }) as CiClient['call'],
    };
    const mounted = await mount(page(flaky));
    await shown(mounted, '[data-ci-failed]');
    await click(must(mounted.container.querySelector('button'), 'Try again'));
    await shown(mounted, '[data-ci-run-page]');
    expect(answered).toBe(2);
  });
});

describe('CiTab', () => {
  const runs = (): CiRun[] => [passingRun(), runningRun(), failedRun(), checkRun()];

  test('asks for the pull request’s runs and lists failing first with a link to each run', async () => {
    const calls: Call[] = [];
    const mounted = await mount(tab(client({ [RUNS_ROUTE]: runs() }, calls)));
    await shown(mounted, '[data-ci-tab]');
    expect(calls[0]).toEqual({
      route: RUNS_ROUTE,
      params: { project: PROJECT, repo: 'octo~hello' },
      query: { pr: '7' },
    });
    const rows = [...mounted.container.querySelectorAll<HTMLElement>('[data-ci-run]')];
    expect(rows.map(row => row.getAttribute('data-ci-run-status'))[0]).toBe('failed');
    expect(rows.length).toBe(4);
    expect(mounted.container.textContent).toContain('4 runs · 1 failed · 1 in progress');
    // Every row says its state in words as well as in its icon.
    expect(rows[0]?.textContent).toContain('Failed');
    expect(rows.map(row => row.textContent).join(' ')).toContain('Running');
    const link = must(rows[0]?.querySelector('a'), 'the first run’s link');
    expect(link.getAttribute('href')).toBe('/d/pulls/ci-run/1002');
    expect(rows[0]?.textContent).toContain('Attempt 2');
  });

  test('no runs says so', async () => {
    const mounted = await mount(tab(client({ [RUNS_ROUTE]: [] })));
    await shown(mounted, '[data-ci-tab]');
    expect(mounted.container.textContent).toContain('No CI has run for this commit yet.');
    expect(mounted.container.textContent).not.toContain('No CI runs');
  });

  test('a branch is asked for by name', async () => {
    const calls: Call[] = [];
    const branch = (
      <RouterProvider>
        <CiTab
          client={client({ [RUNS_ROUTE]: [] }, calls)}
          daemon="d"
          scope={SCOPE}
          target={{ branch: 'feat/x' }}
          nowMs={NOW}
        />
      </RouterProvider>
    );
    await shown(await mount(branch), '[data-ci-tab]');
    expect(calls[0]?.query).toEqual({ branch: 'feat/x' });
  });
});
