import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { IScreenshotWriter } from '../../lib/browser/types.ts';

/** Rejects anything that is not canonical base64 before it becomes a silently corrupt PNG. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * Writes an explicit screenshot to the path the operator named. The daemon persists no images of
 * its own, so this is the only place browser pixels reach the filesystem.
 */
export class FileScreenshotWriter implements IScreenshotWriter {
  async write(path: string, base64: string): Promise<void> {
    if (!base64 || !BASE64.test(base64) || base64.length % 4 !== 0) {
      throw new Error('the daemon returned malformed screenshot bytes');
    }
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(base64, 'base64'));
  }
}
