import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ProjectCloneUrlSchema,
  ProjectCloneUrlUnsupportedMessage,
  type ProjectInfo,
  type ProjectList,
  ProjectListSchema,
  ProjectPathSchema,
  type RegisterProjectRequest,
} from '@ferretry/protocol';
import type { SerialExecutor } from '../../lib/ports.ts';
import { KeyedSerialExecutor } from '../system/keyed-serial-executor.ts';

/**
 * The transports a clone may use, handed to git itself. `ProjectCloneUrlSchema` already refuses every
 * other one; this is the same set where git enforces it, so a host git configuration that enables
 * `ext::`, or anything git follows on the way, cannot reach a transport that runs a command.
 */
const CLONE_PROTOCOLS = 'https:ssh:file';

/**
 * The daemon's authoritative Project registry.  This deliberately has no scan
 * method: a folder observed in a session is a discovery, not a Project, until
 * the caller explicitly confirms it through `register`.
 */
export class FileProjectCatalog {
  constructor(
    private readonly file: string,
    private readonly now: () => string = () => new Date().toISOString(),
    /**
     * Holds each read-dedupe-write of the registry file, so two registrations at once (an owner's
     * `fy project add` and a ferret's first card in the same repository) make one record, and neither write
     * drops the other's. Every registration in the daemon goes through one instance.
     */
    private readonly serial: Pick<SerialExecutor, 'run'> = new KeyedSerialExecutor(),
  ) {}

  async projects(): Promise<ProjectList> {
    const text = await readFile(this.file, 'utf8').catch(error => {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    });
    if (text === undefined) return [];
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Missing is the initial state. Damaged is evidence we cannot interpret.
      throw new Error('the project registry is damaged and cannot be read');
    }
    return ProjectListSchema.parse(value);
  }

  async register(request: RegisterProjectRequest): Promise<ProjectInfo> {
    const root = await this.materialize(request);
    const git = await this.gitAttachment(root);
    return await this.serial.run(this.file, async () => {
      const projects = await this.projects();
      const duplicate = projects.find(
        project => project.path === root || (git && project.git?.commonDirectory === git.commonDirectory),
      );
      if (duplicate !== undefined) return duplicate;
      const record: ProjectInfo = {
        id: randomUUID(),
        name: request.name ?? basename(root),
        path: root,
        source: request.kind,
        createdAt: this.now(),
        ...(git ? { git } : {}),
      };
      await this.write([...projects, record]);
      return record;
    });
  }

  private async materialize(request: RegisterProjectRequest): Promise<string> {
    // The protocol schema owns the absolute-path decision; enforce that same schema here,
    // before resolve(), so a direct caller cannot bypass the trust boundary the mount's
    // parseBody forms. resolve() is total, so checking its output was a dead guard — a
    // relative input became absolute against this daemon's cwd and sailed through.
    const parsed = ProjectPathSchema.safeParse(request.path);
    if (!parsed.success) throw new Error('project path must be absolute');
    const requested = resolve(parsed.data);
    if (request.kind === 'new-folder') {
      await mkdir(requested, { recursive: false, mode: 0o700 });
      if (request.initializeGit) await this.runGit(['init', requested]);
    } else if (request.kind === 'clone') {
      // The same re-parse as the path, for the same reason: a direct caller skips the mount's parseBody.
      const url = ProjectCloneUrlSchema.safeParse(request.url);
      if (!url.success) throw new Error(ProjectCloneUrlUnsupportedMessage);
      await this.runGit(['clone', '--', url.data, requested], { GIT_ALLOW_PROTOCOL: CLONE_PROTOCOLS });
    }
    const information = await stat(requested).catch(() => undefined);
    if (information === undefined || !information.isDirectory())
      throw new Error('project path is not an existing directory');
    return await realpath(requested);
  }

  private async gitAttachment(root: string): Promise<ProjectInfo['git'] | undefined> {
    try {
      const process = Bun.spawn(['git', '-C', root, 'rev-parse', '--git-common-dir'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = (await new Response(process.stdout).text()).trim();
      if ((await process.exited) !== 0 || output === '') return undefined;
      return { commonDirectory: await realpath(resolve(root, output)) };
    } catch {
      return undefined;
    }
  }

  private async runGit(arguments_: readonly string[], environment: Record<string, string> = {}): Promise<void> {
    const process = Bun.spawn(['git', ...arguments_], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, ...environment },
    });
    if ((await process.exited) === 0) return;
    throw new Error(`git ${arguments_[0] ?? 'operation'} failed`);
  }

  private async write(projects: ProjectList): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(projects, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
  }
}
