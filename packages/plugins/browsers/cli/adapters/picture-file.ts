import { writeFile } from 'node:fs/promises';

/** Writes a screenshot to the path the person chose (relative to where `fy` was run). Nothing else persists image bytes. */
export async function writePictureFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes);
}
