import type { FileSystemPort } from '../ports.ts';

/**
 * Deletes the operator password's verifier an older daemon left behind, and says whether it did.
 *
 * The passkey step-up replaced that password with no compatibility path, so the file gates nothing.
 * Left in place it would read as a lock to anyone who found it, which is why boot removes it rather than
 * ignoring it. `true` only when a file was actually there, so the notice is said once and only when it
 * is true.
 */
export async function retireOperatorPassword(
  path: string,
  files: Pick<FileSystemPort, 'information' | 'removeFile'>,
): Promise<boolean> {
  if ((await files.information(path)) === undefined) return false;
  await files.removeFile(path);
  return true;
}
