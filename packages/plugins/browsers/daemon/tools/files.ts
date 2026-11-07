import type { FerretId, FencedPath, RootsPort } from '@ferretry/kernel/contract';
import type { WorkerStagedFile } from '../worker/protocol.ts';
import { AGENT_FILE_LIMITS, DEFAULT_SAVE_FOLDER, forbiddenInside, sanitizeFileName, uploadSizeProblem } from './files-policy.ts';
import { BrowserToolError } from './service.ts';
import type { AgentUploadFile } from './wire.ts';

/**
 * What the file tools may reach (S51: the same guard as every agent file tool): a path inside the ferret's own work
 * folder, resolved through the kernel's `work` root (symlinks resolved before the check, `..` refused, link and
 * device-file checks kept). What a page hands back is saved into that same folder: `saveAs` (relative) or
 * `downloads/<name>`, never over a file unless asked (today's `AgentFiles.save`).
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

/** Moves a staged file the worker wrote to a fenced path; never over a file unless asked. */
export interface StagedFileMover {
  copy(from: string, to: FencedPath, options: { readonly overwrite: boolean; readonly maxBytes: number }): Promise<number>;
}

const leafOf = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

export function rootFiles(roots: RootsPort, mover: StagedFileMover): BrowserFiles {
  return {
    prepareUpload: async (sessionId, files) => {
      const root = roots.root('work', { ferret: sessionId as FerretId });
      const prepared: { path: string; name: string; size: number }[] = [];
      for (const file of files) {
        if (typeof file !== 'string')
          throw new BrowserToolError('bad_request', 'An attachment cannot be uploaded from the browser tools yet: name a file in your folder.');
        const forbidden = forbiddenInside(file);
        if (forbidden !== undefined) throw new BrowserToolError('forbidden', forbidden);
        const resolved = root.resolve(file);
        if (!resolved.ok) throw new BrowserToolError('forbidden', `${file} is not inside your own folder (${resolved.error}).`);
        const stat = await root.stat(resolved.value);
        if (stat?.kind !== 'file') throw new BrowserToolError('not_found', `There is no file ${file} in your folder.`);
        prepared.push({ path: resolved.value, name: leafOf(file), size: stat.size });
      }
      const problem = uploadSizeProblem(prepared.map(file => file.size));
      if (problem !== undefined) throw new BrowserToolError('bad_request', problem);
      return { files: prepared };
    },
    save: async (sessionId, staged, options) => {
      if (staged.size > AGENT_FILE_LIMITS.downloadBytes)
        throw new BrowserToolError('bad_request', 'The file is larger than a download may be saved as.');
      const root = roots.root('work', { ferret: sessionId as FerretId });
      const name = options.saveAs ?? `${DEFAULT_SAVE_FOLDER}/${sanitizeFileName(staged.name, 'download')}`;
      const forbidden = forbiddenInside(name);
      if (forbidden !== undefined) throw new BrowserToolError('forbidden', forbidden);
      const resolved = root.resolve(name);
      if (!resolved.ok) throw new BrowserToolError('forbidden', `${name} is not inside your own folder (${resolved.error}).`);
      if (!options.overwrite && (await root.stat(resolved.value)) !== undefined)
        throw new BrowserToolError('conflict', `${name} already exists; pass overwrite: true to replace it.`);
      const size = await mover
        .copy(staged.path, resolved.value, { overwrite: options.overwrite, maxBytes: AGENT_FILE_LIMITS.downloadBytes })
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
