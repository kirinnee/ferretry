import { mkdir, mkdtemp, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineState } from '@ferretry/kernel/contract';
import { JobService } from '../../../../daemon/adapters/jobs/job-service.ts';
import { StateJobFiles } from '../../../../daemon/adapters/jobs/job-files.ts';
import { TmuxJobRuntime } from '../../../../daemon/adapters/jobs/tmux-job-runtime.ts';
import { type AttachmentsState, EMPTY_ATTACHMENTS } from '../../../../daemon/lib/jobs/attachments.ts';
import type { AttachmentStore, ProcessProof } from '../../../../daemon/lib/jobs/contracts.ts';
import { BunTmuxProcess } from './host-spawn.ts';

export const tree = defineState({ name: 'jobs', path: 'jobs/*', store: 'opaque', format: 1 });

/** The slice of the kernel's state port a job tree uses, over a plain folder: the same operations, the same shapes. */
export function folderState(root: string) {
  const at = (name: string): string => join(root, 'jobs', name);
  return {
    write: async (_def: unknown, value: unknown, name?: string) => {
      await mkdir(dirname(at(name ?? '')), { recursive: true });
      await writeFile(at(name ?? ''), value as string);
    },
    pathOf: (_def: unknown, name?: string) => at(name ?? ''),
    list: async () => await readdir(join(root, 'jobs')).catch(() => []),
    entries: async (_def: unknown, name: string) =>
      (await readdir(at(name), { withFileTypes: true }).catch(() => [])).map(entry => ({
        name: entry.name,
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      })),
    remove: async (_def: unknown, name?: string) => await rm(at(name ?? ''), { force: true }),
    removeEmptyDirectory: async (_def: unknown, name: string) => await rmdir(at(name)),
    createPrivateDirectory: async (_def: unknown, name: string) => {
      await mkdir(dirname(at(name)), { recursive: true });
      await mkdir(at(name));
    },
  };
}

/** Process proof over a table the test controls: a pid is alive while the test says so. */
class TableProof implements ProcessProof {
  readonly starts = new Map<number, string>();
  async startOf(pid: number): Promise<string | undefined> {
    return this.starts.get(pid);
  }
}

export interface Keeper {
  readonly home: string;
  readonly tmux: BunTmuxProcess;
  readonly proof: TableProof;
  readonly clock: { now: number };
  /** A service over the SAME folder and tmux server: a second one is what a restarted daemon is. */
  service(): JobService;
  dispose(): Promise<void>;
}

/** A real tmux on a private socket, a state folder, and services over them. Only the clock and ids are the test's. */
export async function keeper(): Promise<Keeper> {
  const executable = Bun.which('tmux');
  if (executable === null) throw new Error('tmux is required for job integration coverage');
  const home = await mkdtemp(join(tmpdir(), 'fy-job-'));
  const tmux = new BunTmuxProcess(executable, join(home, 'tmux.sock'));
  const proof = new TableProof();
  const clock = { now: Date.now() };
  let attachments: AttachmentsState = EMPTY_ATTACHMENTS;
  const store: AttachmentStore = {
    read: async () => attachments,
    update: async change => (attachments = change(attachments)),
  };
  let counter = 0;
  const sessions = { resolve: async (reference: string) => ({ id: reference, cwd: home }) };
  return {
    home,
    tmux,
    proof,
    clock,
    service: () =>
      new JobService(
        new StateJobFiles(folderState(home) as never, tree),
        new TmuxJobRuntime(tmux, { shell: async () => '/bin/sh' }),
        store,
        proof,
        sessions,
        { now: () => clock.now },
        { next: () => (++counter).toString(16).padStart(12, 'a') },
        { isDirectory: async () => true, sleep: async ms => await new Promise(resolve => setTimeout(resolve, ms)) },
      ),
    dispose: async () => {
      await tmux.execute(['kill-server']).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    },
  };
}
