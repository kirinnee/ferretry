/**
 * A real `fy job attach` process for the deadline test: the real process ports and signal handlers over a gateway that answers
 * the register and then NEVER answers again and ignores every abort, keeping the event loop alive the way a real open request
 * does. Prints `ready` on stdout once it is polling. The test sends it SIGTERM and times how long it takes to end.
 */
import { JobVerbs } from '../../../cli/lib/jobs/controller.ts';
import { RealJobProcess, RealJobSignals, RealJobTimers } from '../../../cli/adapters/jobs/process-ports.ts';

const job = {
  id: 'aaaaaaaaaaa1',
  sessionId: 's1',
  name: 'build',
  command: 'sleep 60',
  cwd: '/work',
  state: 'running',
  startedAt: '2026-11-16T00:00:00.000Z',
  startedBy: { by: 'agent', sessionId: 's1' },
  outputBytes: 0,
  attachments: 0,
};

const gateway = {
  call: async (route: string): Promise<unknown> => {
    if (route.endsWith('/jobs/:jobId') && process.argv[2] !== 'wait') return job;
    if (route.startsWith('POST') && route.endsWith('job-attachments'))
      return {
        id: 'att1',
        sessionId: 's1',
        jobId: job.id,
        pid: process.pid,
        registeredAt: job.startedAt,
        detaching: false,
      };
    // The daemon has stopped answering: the request stays open, and so does the loop.
    process.stdout.write('ready\n');
    setInterval(() => undefined, 1_000);
    return await new Promise(() => undefined);
  },
  subscribe: () => () => undefined,
};

const verbs = new JobVerbs(
  gateway as never,
  { isTty: false, out: () => undefined, err: text => process.stderr.write(text) },
  {
    self: new RealJobProcess(),
    signals: new RealJobSignals(),
    timers: new RealJobTimers(),
    sessionId: 's1',
  },
);
const verb = process.argv[2] === 'wait' ? verbs.wait.bind(verbs) : verbs.attach.bind(verbs);
process.exitCode = await verb({ args: ['build'], options: {} });
