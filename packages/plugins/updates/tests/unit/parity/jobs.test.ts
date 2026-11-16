/** Parity rows J-0024, J-0044, J-0089, J-0123, J-0244 (docs/design/rebuild-parity.tsv). */
import { describe, expect, test } from 'bun:test';
import type { JobSpec, KernelPorts, UpdateHostPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import daemon from '../../../daemon/index.ts';
import { UPDATE_BACKSTOP_INTERVAL_MS } from '../../../daemon/lib/service.ts';
import manifest from '../../../manifest.ts';
import { fakeHost } from '../host.ts';

const RELEASE = {
  tag_name: 'v4.29.0',
  html_url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0',
  draft: false,
  prerelease: false,
  published_at: '2026-10-18T08:00:00Z',
};

/** What the kernel gives a plugin it has no build to show: facts that refuse, launches that fail. */
const refusingHost: UpdateHostPort = {
  release: '4.28.0',
  compiled: false,
  checks: false,
  executable: async () => {
    throw new Error('updates did not declare permissions.updateHost.');
  },
  launchUpdate: async () => ({ kind: 'failed', reason: 'updates did not declare permissions.updateHost.' }),
};

/** The half built over fakes: what it asked the kernel to schedule, and how often GitHub was asked. */
function build(updateHost: UpdateHostPort = fakeHost().port) {
  const jobs: JobSpec[] = [];
  const asked: string[] = [];
  const stored = new Map<string, unknown>();
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
  const kernel = {
    updateHost,
    identity: { binaries: { client: 'fy', daemon: 'fyd' } },
    paths: { home: () => '/home/kirin' },
    jobs: { add: (job: JobSpec) => void jobs.push(job), kick: () => undefined },
    config: { file: () => undefined, collection: () => new Map(), watch: () => () => undefined },
    state: {
      read: async (file: { path: string }) => ({ ok: true, value: stored.get(file.path) }),
      write: async (file: { path: string }, value: unknown) => void stored.set(file.path, value),
      remove: async () => undefined,
    },
    fetch: {
      request: async (url: string | URL) => {
        asked.push(String(url));
        return Response.json(RELEASE);
      },
    },
    spawn: { run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }) },
    clock: { nowMs: () => Date.parse('2026-10-18T10:00:00.000Z') },
    events: { publish: () => undefined },
    log: quiet,
  } as unknown as KernelPorts;
  const half = daemon.build?.({
    manifest,
    needs: { ferrets: { list: async () => [] } },
    uses: {},
    hooks: {} as never,
    kernel,
  } as unknown as DaemonContext<typeof manifest>);
  return { half, jobs, asked };
}

describe('the update check loop', () => {
  test('J-0024 J-0044 J-0089 the check is armed by the kernel after listen, once at boot and then on a backstop', () => {
    const { jobs } = build();
    expect(jobs.map(job => [job.id, job.schedule])).toEqual([
      ['update-boot', { onceAfterStart: true }],
      ['update', { every: milliseconds(UPDATE_BACKSTOP_INTERVAL_MS) }],
    ]);
  });

  test('J-0123 J-0244 each run of the loop looks again, and GitHub is asked only when the last answer is due', async () => {
    const { jobs, asked } = build();
    const signal = new AbortController().signal;
    await jobs[0]?.run(signal);
    await jobs[1]?.run(signal);
    expect(asked).toEqual(['https://api.github.com/repos/kirinnee/ferretry/releases/latest']);
  });

  test('J-0024 without the host seam the armed loop asks GitHub nothing', async () => {
    const { jobs, asked } = build(refusingHost);
    const signal = new AbortController().signal;
    for (const job of jobs) await job.run(signal);
    expect(asked).toEqual([]);
  });
});
