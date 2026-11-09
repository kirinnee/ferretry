import type { HostFs } from '../state/host-fs.ts';
import type { DiskState } from './evaluate.ts';
import { CONFIG_FILE_MAX_BYTES, configTextTooLarge } from './yaml-text.ts';

/**
 * One configuration file as the kernel reads it, at boot, on every reload and under `fyd --check`: a link, a
 * non-regular file or one past the 256 KiB cap is `unreadable` (its last good version stays), never read whole.
 */
export async function readConfigDisk(fs: HostFs, absolute: string): Promise<DiskState> {
  let info: Awaited<ReturnType<HostFs['info']>>;
  try {
    info = await fs.info(absolute);
  } catch {
    return { kind: 'unreadable' };
  }
  if (info === undefined) return { kind: 'absent' };
  if (!info.regularFile || info.size > CONFIG_FILE_MAX_BYTES) return { kind: 'unreadable' };
  try {
    // Read with a hard bound, at most one byte past the cap: the size above was read before the bytes, and a file
    // that grew in between is never read whole — only far enough to see it is over the cap.
    const read = await fs.readTail(absolute, CONFIG_FILE_MAX_BYTES + 1);
    if (read === undefined) return { kind: 'absent' };
    if (read.from > 0 || read.bytes.byteLength > CONFIG_FILE_MAX_BYTES) return { kind: 'unreadable' };
    const text = new TextDecoder().decode(read.bytes);
    return configTextTooLarge(text) ? { kind: 'unreadable' } : { kind: 'text', text };
  } catch {
    return { kind: 'unreadable' };
  }
}
