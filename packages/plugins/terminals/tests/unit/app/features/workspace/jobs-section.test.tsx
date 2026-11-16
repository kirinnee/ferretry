import { afterEach, describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { JobsSection, jobAgeText, jobStateText } from '../../../../../app/features/workspace/jobs-section.tsx';
import { daemonConnection, daemonSessionScope } from '../../../../../app/shell.ts';
import type { JobView } from '../../../../../contract/index.ts';

const scope = daemonSessionScope(daemonConnection('jobs-daemon'), 'agent-session');
const job = (over: Partial<JobView>): JobView => ({
  id: 'aaaaaaaaaaa1',
  sessionId: 'agent-session',
  name: 'build',
  command: 'bun test',
  cwd: '/work',
  state: 'running',
  startedAt: '2026-11-16T00:00:00.000Z' as never,
  startedBy: { by: 'person' },
  outputBytes: 0,
  attachments: 0,
  ...over,
});
const NOW = Date.parse('2026-11-16T00:05:00.000Z');

describe('job words', () => {
  it('should say how a job ended, with the signal, and how old it is', () => {
    expect(jobStateText(job({}))).toBe('running');
    expect(jobStateText(job({ state: 'exited', exitCode: 0 }))).toBe('exit 0');
    expect(jobStateText(job({ state: 'exited', exitCode: 143, signal: 'TERM' }))).toBe('exit 143 (TERM)');
    expect(jobStateText(job({ state: 'lost' }))).toBe('lost');
    expect(jobAgeText(job({}), NOW)).toBe('5m');
  });
});

describe('the background jobs section', () => {
  const mounted: { unmount: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
  });

  const client = (jobs: JobView[]): { call: <Answer>(route: string) => Promise<Answer> } => ({
    call: async <Answer,>(route: string): Promise<Answer> => {
      if (route.endsWith('/output'))
        return { text: 'line one\nline two\n', next: 18, size: 18, job: jobs[0], ended: true, detach: false } as Answer;
      return {
        sessionId: 'agent-session',
        jobs,
        limits: { runningPerFerret: 8, runningGlobal: 48, running: 1, retentionDays: 7, retainedFinishedPerFerret: 50 },
      } as Answer;
    },
  });
  const settle = async () =>
    await interact(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });

  it('should list each job with its name, state, age and command, and open its log on a press', async () => {
    const view = await mount(
      <JobsSection
        client={client([job({}), job({ id: 'bbbbbbbbbbb2', name: 'old', state: 'exited', exitCode: 1 })])}
        now={() => NOW}
        pollMs={60_000}
        scope={scope}
      />,
    );
    mounted.push(view);
    await settle();

    const rows = [...view.container.querySelectorAll('[data-job]')];
    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['running', 'exited']);
    expect(view.container.textContent).toContain('Background jobs');
    expect(view.container.textContent).toContain('exit 1');
    expect(view.container.textContent).toContain('bun test');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-job] button'), 'a job row').click(),
    );
    await settle();
    expect(must(view.container.querySelector('[data-job-log]'), 'the log').textContent).toContain('line two');
  });

  it('should draw nothing when the ferret has no jobs', async () => {
    const view = await mount(<JobsSection client={client([])} pollMs={60_000} scope={scope} />);
    mounted.push(view);
    await settle();
    expect(view.container.innerHTML).toBe('');
  });
});
