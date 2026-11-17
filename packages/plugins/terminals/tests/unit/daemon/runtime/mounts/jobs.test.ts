import { describe, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  JobAttachmentListViewSchema,
  JobListViewSchema,
  JobOutputViewSchema,
  JobViewSchema,
} from '../../../../../contract/index.ts';
import { fileIdentity } from '../../../../../daemon/adapters/jobs/executable-identity.ts';
import { MemoryFiles, MemoryRuntime } from '../../../../support/daemon/job-fakes.ts';
import { FERRET, jsonBody, type MountHalf, mountHalf } from './support.ts';

/** The real half over in-memory job files and a keeper the test controls (the test host's state is not on disk). */
const mount = async (trusted: readonly string[] = []) => {
  const files = new MemoryFiles();
  const runtime = new MemoryRuntime();
  return {
    files,
    runtime,
    half: await mountHalf({ jobs: { files, runtime, trustedExecutables: async () => trusted } }),
  };
};

/**
 * The job routes, through the kernel's test host and Terminals' real half. tmux is scripted (it starts nothing), so what is
 * asserted here is the HTTP surface: who may act on whose jobs, what is refused and how, and the shape of each answer. What a
 * started job really does is the keeper's integration tests.
 */

const JOBS = `/v1/ferrets/${FERRET}/jobs`;
const ATTACH = `/v1/ferrets/${FERRET}/job-attachments`;
const start = async (
  half: MountHalf,
  body: unknown = { command: 'echo hi', cwd: tmpdir() },
  as: 'owner' | 'ferret' = 'owner',
) => await half.call('POST', JOBS, body, as);

describe('the job mount', () => {
  it('should start a job as the owner and list it, masked and shaped by the contract', async () => {
    const { half } = await mount();

    const started = await start(half, { command: 'echo hunter2', cwd: tmpdir(), name: 'say' });
    const listed = await half.call('GET', JOBS);
    const one = await half.call('GET', `${JOBS}/say`);

    should(started.status).equal(200);
    const job = JobViewSchema.parse(jsonBody(started));
    should(job.name).equal('say');
    should(job.startedBy).deepEqual({ by: 'person' });
    should(job.command).not.containEql('hunter2');
    should(JobListViewSchema.parse(jsonBody(listed)).jobs).have.length(1);
    should(JobViewSchema.parse(jsonBody(one)).id).equal(job.id);
  });

  it('should record a ferret as the starter of its own job', async () => {
    const { half } = await mount();
    const started = await start(half, { command: 'ls', cwd: tmpdir() }, 'ferret');
    should(JobViewSchema.parse(jsonBody(started)).startedBy).deepEqual({ by: 'agent', sessionId: FERRET });
  });

  it("should refuse a ferret acting on another ferret's jobs", async () => {
    const { half } = await mount();
    const other = await half.call('GET', '/v1/ferrets/f-someone-else/jobs', undefined, 'ferret');
    should(other.status).equal(403);
  });

  it('should refuse a missing folder, an empty command, an unknown job and an unknown ferret in words', async () => {
    const { half } = await mount();
    should((await start(half, { command: 'ls', cwd: '/definitely/not/here' })).status).equal(400);
    should((await start(half, { command: '' })).status).equal(400);
    should((await half.call('GET', `${JOBS}/nothing`)).status).equal(404);
    should((await half.call('GET', `${JOBS}/Bad Name!`)).status).equal(400);
    should((await half.call('GET', '/v1/ferrets/ghost/jobs')).status).equal(404);
    should((await half.call('GET', '/v1/ferrets/%2e%2e/jobs')).status).equal(400);
  });

  it("should read a job's output with a byte offset or a tail, and refuse a query it cannot read", async () => {
    const { half } = await mount();
    const job = JobViewSchema.parse(jsonBody(await start(half)));
    const out = await half.call('GET', `${JOBS}/${job.id}/output`);
    should(JobOutputViewSchema.parse(jsonBody(out)).text).equal('');
    const tail = await half.host.request('GET', `${JOBS}/${job.id}/output`, {
      query: { tail: '5', attachment: 'x' },
      as: { kind: 'owner' },
    });
    should(tail.status).equal(200);
    const from = await half.host.request('GET', `${JOBS}/${job.id}/output`, {
      query: { from: '0' },
      as: { kind: 'owner' },
    });
    should(from.status).equal(200);
    const bad = await half.host.request('GET', `${JOBS}/${job.id}/output`, {
      query: { from: 'x' },
      as: { kind: 'owner' },
    });
    should(bad.status).equal(400);
  });

  it('should answer a stop for a job that has already ended with how it ended', async () => {
    const { half, files } = await mount();
    const job = JobViewSchema.parse(jsonBody(await start(half)));
    files.exits.set(`${FERRET}/${job.id}`, { code: 3, endedAt: '2026-11-16T00:00:01.000Z' as never });

    const stopped = await half.call('POST', `${JOBS}/${job.id}/stop`);

    should(stopped.status).equal(200);
    should(JobViewSchema.parse(jsonBody(stopped)).exitCode).equal(3);
  });

  it('should register, list, detach and unregister an attachment', async () => {
    // A real process whose command line is `fy job attach …` and that runs the trusted executable (the keeper registers nothing
    // else): a bun script stands in for `fy`, trusted as the runtime plus that script, the source-checkout shape.
    const folder = mkdtempSync(join(tmpdir(), 'fy-attach-'));
    writeFileSync(join(folder, 'fy.ts'), 'setInterval(() => undefined, 1000);');
    const { half } = await mount([
      `${await fileIdentity(Bun.which('bun') ?? 'bun')}#${realpathSync(join(folder, 'fy.ts'))}`,
    ]);
    const job = JobViewSchema.parse(jsonBody(await start(half)));
    const attacher = Bun.spawn(['bun', join(folder, 'fy.ts'), 'job', 'attach', job.id]);
    const stranger = Bun.spawn(['sleep', '30']);
    let id = '';
    try {
      const bad = await half.call('POST', ATTACH, { jobId: job.id, pid: 2_000_000_000 });
      const forged = await half.call('POST', ATTACH, { jobId: job.id, pid: stranger.pid });
      const made = await half.call('POST', ATTACH, { jobId: job.id, pid: attacher.pid, claudeTaskId: 'task9' });
      should(bad.status).equal(400);
      should(forged.status).equal(400);
      should(made.status).equal(200);
      id = (jsonBody(made) as { id: string }).id;
      should(JobAttachmentListViewSchema.parse(jsonBody(await half.call('GET', ATTACH))).attachments).have.length(1);

      const detached = await half.call('POST', `${ATTACH}/detach`, { jobId: job.id });
      should(jsonBody(detached)).deepEqual({ detached: 1 });
      should(jsonBody(await half.call('POST', `${ATTACH}/detach`))).deepEqual({ detached: 0 });

      should((await half.call('DELETE', `${ATTACH}/${id}`)).status).equal(200);
      should(JobAttachmentListViewSchema.parse(jsonBody(await half.call('GET', ATTACH))).attachments).have.length(0);
    } finally {
      attacher.kill();
      stranger.kill();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
