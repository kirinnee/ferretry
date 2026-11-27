import { isPrivateFolder, isSecretFileName, isSecretFolderName } from '@ferretry/std';

/** A closed deny policy for EVERY outgoing path, including Git's historical trees. */
export function namesASecret(path: string): boolean {
  const segments = path.split('/');
  return segments.some(
    (segment, index) =>
      isPrivateFolder(segments.slice(index)) ||
      isSecretFileName(segment) ||
      isSecretFolderName(segment) ||
      ['.claude.json', 'environment.json', 'tokens.json', '.claude', '.codex', '.ferretry', '.ferretry5'].includes(
        segment.toLowerCase(),
      ),
  );
}
