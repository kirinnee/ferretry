import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectListSchema, type ProjectInfo, type ProjectList, type RegisterProjectRequest } from '@ferretry/protocol';

/**
 * The daemon's authoritative Project registry.  This deliberately has no scan
 * method: a folder observed in a session is a discovery, not a Project, until
 * the caller explicitly confirms it through `register`.
 */
export class FileProjectCatalog {
  constructor(
    private readonly file: string,
    private readonly now: () => string = () => new Date().toISOString(),
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
    const projects = await this.projects();
    const git = await this.gitAttachment(root);
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
  }

  private async materialize(request: RegisterProjectRequest): Promise<string> {
    const requested = resolve(request.path);
    if (!isAbsolute(requested)) throw new Error('project path must be absolute');
    if (request.kind === 'new-folder') {
      await mkdir(requested, { recursive: false, mode: 0o700 });
      if (request.initializeGit) await this.runGit(['init', requested]);
    } else if (request.kind === 'clone') {
      await this.runGit(['clone', '--', request.url, requested]);
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

  private async runGit(arguments_: readonly string[]): Promise<void> {
    const process = Bun.spawn(['git', ...arguments_], { stdout: 'pipe', stderr: 'pipe' });
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
