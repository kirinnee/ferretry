import type { JobExit, JobMeta } from '../../../contract/index.ts';
import { JobService } from '../../../daemon/adapters/jobs/job-service.ts';
import { type AttachmentsState, EMPTY_ATTACHMENTS } from '../../../daemon/lib/jobs/attachments.ts';
import type { JobFilesPort, JobRuntimePort, RunningJob } from '../../../daemon/lib/jobs/contracts.ts';

/** Job files in memory: the wrapper's part (log, exit record) is played by the test. */
export class MemoryFiles implements JobFilesPort {
  readonly metas = new Map<string, JobMeta>();
  readonly exits = new Map<string, JobExit>();
  readonly logs = new Map<string, string>();
  readonly stops = new Set<string>();
  failWrite = false;
  private key = (owner: string, id: string): string => `${owner}/${id}`;
  async create(owner: string, id: string): Promise<string> {
    this.logs.set(this.key(owner, id), '');
    return `/state/${owner}/${id}`;
  }
  async writeMeta(owner: string, id: string, meta: JobMeta): Promise<void> {
    if (this.failWrite) throw new Error('disk full');
    this.metas.set(this.key(owner, id), meta);
  }
  async readMeta(owner: string, id: string): Promise<JobMeta | undefined> {
    return this.metas.get(this.key(owner, id));
  }
  async readExit(owner: string, id: string): Promise<JobExit | undefined> {
    return this.exits.get(this.key(owner, id));
  }
  async writeExit(owner: string, id: string, exit: JobExit): Promise<void> {
    this.exits.set(this.key(owner, id), exit);
  }
  async requestStop(owner: string, id: string): Promise<void> {
    this.stops.add(this.key(owner, id));
  }
  async outputSize(owner: string, id: string): Promise<number> {
    return Buffer.byteLength(this.logs.get(this.key(owner, id)) ?? '');
  }
  async readOutput(owner: string, id: string, from: number, max: number): Promise<Uint8Array> {
    return Buffer.from(this.logs.get(this.key(owner, id)) ?? '').subarray(from, from + max);
  }
  async list() {
    return [...this.metas.keys()].map(key => ({ owner: key.split('/')[0] ?? '', id: key.split('/')[1] ?? '' }));
  }
  async remove(owner: string, id: string): Promise<void> {
    this.metas.delete(this.key(owner, id));
    this.exits.delete(this.key(owner, id));
    this.logs.delete(this.key(owner, id));
  }
}

/** A keeper whose sessions the test controls: it starts them, lists them and (when told to) fails to kill them. */
export class MemoryRuntime implements JobRuntimePort {
  readonly sessions: RunningJob[] = [];
  failStart = false;
  killed: string[] = [];
  async start(input: Parameters<JobRuntimePort['start']>[0]): Promise<RunningJob> {
    if (this.failStart) throw new Error('tmux refused');
    const job = { owner: input.owner, id: input.id, tmuxSession: `fy-job-${input.owner}-${input.id}` };
    this.sessions.push(job);
    return job;
  }
  async list(): Promise<readonly RunningJob[]> {
    return [...this.sessions];
  }
  async kill(job: RunningJob): Promise<void> {
    this.killed.push(job.id);
  }
}

export function memoryService(over: { isDirectory?: (path: string) => Promise<boolean> } = {}) {
  const files = new MemoryFiles();
  const runtime = new MemoryRuntime();
  const clock = { now: Date.parse('2026-11-16T00:00:00.000Z') };
  let attachments: AttachmentsState = EMPTY_ATTACHMENTS;
  const starts = new Map<number, string | undefined | 'unknown'>();
  let counter = 0;
  const service = new JobService(
    files,
    runtime,
    { read: async () => attachments, update: async change => (attachments = change(attachments)) },
    { startOf: async pid => (starts.has(pid) ? starts.get(pid) : undefined) },
    { resolve: async reference => (reference === 'ghost' ? undefined : { id: reference, cwd: '/work' }) },
    { now: () => clock.now },
    { next: () => (++counter).toString(16).padStart(12, 'b') },
    {
      isDirectory: over.isDirectory ?? (async () => true),
      sleep: async ms => {
        clock.now += ms;
      },
    },
  );
  return { service, files, runtime, clock, starts };
}
