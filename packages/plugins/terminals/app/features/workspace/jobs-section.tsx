/**
 * BACKGROUND JOBS, under the Processes list (docs/jobs.md): the commands the keeper runs for this ferret — name, state, age, exit
 * code — and, opened, the tail of each one's log. A job is not a process of the agent's: it lives in the daemon-owned tmux
 * server, so it is listed here from the daemon's own record and stays after the agent that started it was moved.
 *
 * The list is polled while the section is mounted; a log only while its row is open and the job runs. A failed read keeps the last
 * answer on screen and says so; it never blanks the list.
 */
import { useEffect, useState } from 'react';
import {
  type JobListView,
  JobListViewSchema,
  type JobOutputView,
  JobOutputViewSchema,
  type JobView,
} from '../../../contract/index.ts';
import type { ProcessCalls } from '../../lib/session-processes.ts';
import type { DaemonSessionScope } from '../../shell.ts';

const JOB_ROUTES = {
  list: 'GET /v1/ferrets/:ferretId/jobs',
  output: 'GET /v1/ferrets/:ferretId/jobs/:jobId/output',
} as const;

const JOBS_POLL_MS = 3_000;
const JOB_LOG_POLL_MS = 1_500;
const JOB_LOG_TAIL_LINES = 200;

export interface JobsSectionProps {
  readonly client: ProcessCalls;
  readonly scope: DaemonSessionScope;
  readonly now?: () => number;
  readonly pollMs?: number;
}

/** "running", "exit 0", "exit 143 (TERM)" or "lost". */
export function jobStateText(job: JobView): string {
  if (job.state === 'running') return 'running';
  if (job.state === 'lost') return 'lost';
  return job.signal === undefined
    ? `exit ${String(job.exitCode ?? '?')}`
    : `exit ${String(job.exitCode ?? '?')} (${job.signal})`;
}

/** The job's age in the coarsest sensible unit. */
export function jobAgeText(job: JobView, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(job.startedAt)) / 1_000));
  if (seconds < 90) return `${String(seconds)}s`;
  if (seconds < 5_400) return `${String(Math.round(seconds / 60))}m`;
  if (seconds < 172_800) return `${String(Math.round(seconds / 3_600))}h`;
  return `${String(Math.round(seconds / 86_400))}d`;
}

function JobLog({
  client,
  scope,
  job,
  pollMs,
}: {
  client: ProcessCalls;
  scope: DaemonSessionScope;
  job: JobView;
  pollMs: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      let again = true;
      try {
        const view: JobOutputView = JobOutputViewSchema.parse(
          await client.call(JOB_ROUTES.output, {
            params: { ferretId: scope.sessionId, jobId: job.id },
            query: { tail: String(JOB_LOG_TAIL_LINES) },
            quiet: true,
          }),
        );
        if (live) {
          setText(view.text);
          setProblem(null);
        }
        again = !view.ended;
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : 'the log could not be read');
      }
      if (live && again) timer = setTimeout(() => void read(), pollMs);
    };
    void read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, scope.sessionId, job.id, pollMs]);
  return (
    <div className="fy-proc-job-log" data-job-log={job.id}>
      {problem === null ? null : (
        <p className="text-meta text-err" role="status">
          Could not read the log — {problem}
        </p>
      )}
      <pre className="fy-proc-job-log__text">{text === null ? 'Loading…' : text === '' ? '(no output yet)' : text}</pre>
    </div>
  );
}

export function JobsSection({ client, scope, now = Date.now, pollMs = JOBS_POLL_MS }: JobsSectionProps) {
  const [list, setList] = useState<JobListView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const view = JobListViewSchema.parse(
          await client.call(JOB_ROUTES.list, { params: { ferretId: scope.sessionId }, quiet: true }),
        );
        if (live) {
          setList(view);
          setProblem(null);
        }
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : 'the jobs could not be read');
      }
      if (live) timer = setTimeout(() => void read(), pollMs);
    };
    void read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, scope.sessionId, pollMs]);

  if (list === null || list.jobs.length === 0) return null;
  const nowMs = now();
  return (
    <section aria-labelledby="fy-proc-group-jobs" className="fy-proc-group" data-group="jobs">
      <h3 className="fy-proc-group__heading text-meta" id="fy-proc-group-jobs">
        Background jobs
      </h3>
      {problem === null ? null : (
        <p className="fy-proc-banner text-meta" role="status">
          Showing the last answer — {problem}
        </p>
      )}
      <ul className="fy-proc-list">
        {list.jobs.map(job => (
          <li className="fy-proc-job" data-job={job.id} data-state={job.state} key={job.id}>
            <button
              aria-expanded={openId === job.id}
              className="fy-proc-job__row"
              onClick={() => setOpenId(openId === job.id ? null : job.id)}
              type="button"
            >
              <span className="fy-proc-job__name">{job.name}</span>
              <span className="fy-proc-job__state text-meta">{jobStateText(job)}</span>
              <span className="fy-proc-job__age text-meta">{jobAgeText(job, nowMs)}</span>
              <span className="fy-proc-job__command text-muted">{job.command}</span>
            </button>
            {openId === job.id ? <JobLog client={client} job={job} pollMs={JOB_LOG_POLL_MS} scope={scope} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
