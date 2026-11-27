/** The longest project-folder name Claude writes as it is; a longer one is cut here and given a hash (measured on 2.1.327). */
const MAX_PROJECT_FOLDER = 200;

/** The hash Claude puts at the end of a shortened name: a 32-bit `hash * 31 + code` over the folder, absolute, in base 36. */
function folderHash(cwd: string): string {
  let hash = 0;
  for (let index = 0; index < cwd.length; index += 1) hash = (Math.imul(hash, 31) + cwd.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

/** Claude's own spelling of a working folder as a project-folder name: dashes for every other character, shortened with a hash past 200. */
export function claudeProjectFolder(cwd: string): string {
  const dashed = cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-');
  return dashed.length <= MAX_PROJECT_FOLDER ? dashed : `${dashed.slice(0, MAX_PROJECT_FOLDER)}-${folderHash(cwd)}`;
}

/** The filename is the identity; never select a transcript by recency. */
export function claudeTranscriptPath(cwd: string, conversation: string): string {
  return `projects/${claudeProjectFolder(cwd)}/${conversation}.jsonl`;
}

/** S45: a conversation id is one plain name at every boundary. */
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value);
}
