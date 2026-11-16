import type { FencedPath, FerretId, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import type { WorkerStagedFile } from '../worker/protocol.ts';
import {
  AGENT_FILE_LIMITS,
  DEFAULT_SAVE_FOLDER,
  forbiddenInside,
  sanitizeFileName,
  uploadSizeProblem,
} from './files-policy.ts';
import { BrowserToolError } from './service.ts';
import type { AgentUploadFile } from './wire.ts';

/**
 * What the file tools may reach (S51: the same guard as every agent file tool) — today's `AgentFiles`, over the
 * kernel's `work` root. A path is resolved inside the ferret's own folder, and READ through the root, which resolves
 * links and refuses one that leaves the folder, a fenced path (the daemon's state home) or a device file. The page is
 * handed the daemon's OWN copy of what was read, never the ferret's path, so nothing can swap the file between the
 * check and the browser reading it. What a page hands back is saved into that same folder: `saveAs` (relative) or
 * `downloads/<name>`, never over a file unless asked.
 */
export interface BrowserFiles {
  prepareUpload(
    sessionId: string,
    files: readonly AgentUploadFile[],
  ): Promise<{ readonly files: readonly { readonly path: string; readonly name: string; readonly size: number }[] }>;
  save(
    sessionId: string,
    staged: WorkerStagedFile,
    options: { readonly saveAs?: string | undefined; readonly overwrite: boolean },
  ): Promise<{ readonly saved: string; readonly size: number }>;
}

/** The bytes the file tools write: the daemon's own upload copies, and a staged download saved into the folder. */
export interface StagedFileMover {
  /** Places one upload copy in a fresh private directory and answers its path; older copies past their time go. */
  place(name: string, bytes: Uint8Array): Promise<string>;
  copy(
    from: string,
    to: FencedPath,
    options: { readonly overwrite: boolean; readonly maxBytes: number },
  ): Promise<number>;
}

const leafOf = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

/** The kernel root's refusal (`RootError`: a link out of the folder, a fenced path, a device file) in this domain's words. */
function refusalOf(error: unknown, shown: string): BrowserToolError {
  if (error instanceof BrowserToolError) return error;
  const refusal = (error as { readonly refusal?: unknown } | undefined)?.refusal;
  if (refusal === 'fenced')
    return new BrowserToolError(
      'forbidden',
      `${shown} is in this daemon's state home, which no agent may read or write.`,
    );
  if (typeof refusal === 'string')
    return new BrowserToolError('forbidden', `${shown} is not inside your own folder (${refusal}).`);
  return new BrowserToolError('not_found', `There is no file ${shown} in your folder.`);
}

function resolved(root: RootHandle, requested: string): FencedPath {
  const forbidden = forbiddenInside(requested);
  if (forbidden !== undefined) throw new BrowserToolError('forbidden', forbidden);
  const path = root.resolve(requested);
  if (!path.ok) {
    if (path.error === 'fenced')
      throw new BrowserToolError(
        'forbidden',
        `${requested} is in this daemon's state home, which no agent may read or write.`,
      );
    throw new BrowserToolError('forbidden', `${requested} is not inside your own folder (${path.error}).`);
  }
  return path.value;
}

export function rootFiles(roots: RootsPort, mover: StagedFileMover): BrowserFiles {
  return {
    prepareUpload: async (sessionId, files) => {
      const root = roots.root('work', { ferret: sessionId as FerretId });
      const prepared: { path: string; name: string; size: number }[] = [];
      for (const file of files) {
        if (typeof file !== 'string')
          throw new BrowserToolError(
            'bad_request',
            'An attachment cannot be uploaded from the browser tools yet: name a file in your folder.',
          );
        const path = resolved(root, file);
        const stat = await root.stat(path).catch((error: unknown) => {
          throw refusalOf(error, file);
        });
        if (stat?.kind !== 'file') throw new BrowserToolError('not_found', `There is no file ${file} in your folder.`);
        const problem = uploadSizeProblem([...prepared.map(each => each.size), stat.size]);
        if (problem !== undefined) throw new BrowserToolError('bad_request', problem);
        const bytes = await root.readBytes(path, AGENT_FILE_LIMITS.fileBytes + 1).catch((error: unknown) => {
          throw refusalOf(error, file);
        });
        const name = sanitizeFileName(leafOf(file), 'file');
        prepared.push({ path: await mover.place(name, bytes), name, size: bytes.byteLength });
      }
      return { files: prepared };
    },
    save: async (sessionId, staged, options) => {
      if (staged.size > AGENT_FILE_LIMITS.downloadBytes)
        throw new BrowserToolError('bad_request', 'that file is over the save size limit');
      const root = roots.root('work', { ferret: sessionId as FerretId });
      const name = options.saveAs ?? `${DEFAULT_SAVE_FOLDER}/${sanitizeFileName(staged.name, 'download')}`;
      const path = resolved(root, name);
      const existing = await root.stat(path).catch((error: unknown) => {
        const refusal = (error as { readonly refusal?: unknown } | undefined)?.refusal;
        if (typeof refusal === 'string') throw refusalOf(error, name);
        return undefined;
      });
      if (!options.overwrite && existing !== undefined)
        throw new BrowserToolError('conflict', `${name} already exists; pass overwrite: true to replace it.`);
      const size = await mover
        .copy(staged.path, path, { overwrite: options.overwrite, maxBytes: AGENT_FILE_LIMITS.downloadBytes })
        .catch(() => {
          throw new BrowserToolError(
            'bad_request',
            'that file could not be saved whole: it grew past the save size limit, or the write failed',
          );
        });
      return { saved: name, size };
    },
  };
}
