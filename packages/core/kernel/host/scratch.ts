import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../contract/bound.ts';
import type { ScratchDirectory, ScratchPort } from '../contract/ports.ts';

/** A plain relative name inside the scratch folder: no `..`, `.`, empty part, leading `/` or NUL. */
function checked(rel: string): string {
  if (
    rel === '' ||
    rel.startsWith('/') ||
    rel.includes('\0') ||
    rel.split('/').some(p => p === '' || p === '.' || p === '..')
  )
    throw new TypeError('a scratch name is a plain relative path');
  return rel;
}

/**
 * Fresh private folders (today's `mkdtemp(tmpdir(), 'ferretry-diff-')`, 0700), each removed recursively on close.
 * A link this folder made is never written THROUGH: a name at or under one is refused, and a file is created with
 * `O_CREAT|O_EXCL|O_NOFOLLOW`, so staging a symlink side cannot turn a later write into one outside the folder.
 */
export function scratchPort(prefix = 'ferretry-'): ScratchPort {
  return {
    open: async (): Promise<ScratchDirectory> => {
      const path = await realpath(await mkdtemp(`${tmpdir()}/${prefix}`));
      await chmod(path, 0o700);
      const links = new Set<string>();
      let closed = false;
      const inside = (rel: string): string => {
        if (closed) throw new Error('the scratch folder is closed');
        const name = checked(rel);
        const parts = name.split('/');
        for (let i = 1; i <= parts.length; i += 1)
          if (links.has(parts.slice(0, i).join('/'))) throw new TypeError('a scratch name may not pass through a link');
        return `${path}/${name}`;
      };
      return {
        path: path as FencedPath,
        makeDirectory: async (rel, mode = 0o700) => {
          await mkdir(inside(rel), { recursive: true, mode });
        },
        writeFile: async (rel, data, mode = 0o600) => {
          const target = inside(rel);
          const handle = await open(
            target,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            mode,
          );
          try {
            await handle.writeFile(data);
            // a created file's mode is subject to umask; chmod on the open handle is not
            await handle.chmod(mode);
          } finally {
            await handle.close();
          }
        },
        symlink: async (rel, target) => {
          const at = inside(rel);
          await symlink(target, at);
          links.add(checked(rel));
        },
        close: async () => {
          if (closed) return;
          closed = true;
          await rm(path, { recursive: true, force: true });
        },
      };
    },
  };
}
