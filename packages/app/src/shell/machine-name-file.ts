import type { ShellPluginClient } from '../client/daemon-client.ts';

/**
 * THE MACHINE'S NAME, AS THE DAEMON KEEPS IT: `host.yaml`, read and written through the config-file route the Settings
 * name tab edits, so the daemon governs a save here exactly as it governs that tab. Nothing here decides who may rename
 * a machine. Shared by the "Name this machine" step and the save of a name typed on the pair screen.
 */

const HOST_FILE = 'host.yaml';
const NAME_LINE = /^name:/mu;

export interface HostFile {
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
}

/** Whether the machine's owner has named it (a `name` in `host.yaml`); without one it goes by its host name. */
export const hostFileIsNamed = (file: { readonly exists: boolean; readonly text: string }): boolean =>
  file.exists && NAME_LINE.test(file.text);

/** The text a name is saved as: a JSON string is a valid YAML scalar, so no character needs its own escaping. */
const hostFileText = (name: string): string => `name: ${JSON.stringify(name)}\n`;

export const readHostFile = async (client: ShellPluginClient, quiet = false): Promise<HostFile> => {
  // `quiet`: a read the machine switcher makes by itself on a page load, which must never raise a passkey prompt; a refusal is the answer.
  const answer = (await client.call('GET /v1/config/file', {
    query: { path: HOST_FILE },
    ...(quiet ? { quiet: true } : {}),
  })) as Partial<HostFile> | null;
  // The write needs the revision it read: an answer with none is unreadable, never a revision of ''.
  if (answer === null || typeof answer.etag !== 'string' || answer.etag === '') throw new Error('unreadable');
  return {
    exists: answer.exists === true,
    text: typeof answer.text === 'string' ? answer.text : '',
    etag: answer.etag,
  };
};

/** Writes `name` over the revision `etag` of the file. */
export const writeMachineName = async (client: ShellPluginClient, name: string, etag: string): Promise<void> => {
  await client.call('PUT /v1/config/file', { body: { path: HOST_FILE, text: hostFileText(name), etag } });
};

/** Reads the file fresh, then writes `name` over what was read: a revision from an earlier read is never reused. */
export const saveMachineName = async (client: ShellPluginClient, name: string): Promise<void> => {
  await writeMachineName(client, name, (await readHostFile(client)).etag);
};

/** What went wrong, in a sentence: the daemon's own words when it said any. */
export const sentenceOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
};
