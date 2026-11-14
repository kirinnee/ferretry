/**
 * `ConfigFiles` OVER THE KERNEL'S CONFIGURATION-FILE ROUTES (docs/config-files.md, D2 #3): the page reads `packs.yaml`
 * with `GET /v1/config/file?path=` and writes it back with `PUT /v1/config/file`, against the etag it read. The routes
 * are the kernel's and no plugin declares them (Gate answers per file who may read or write it), so they are reached by
 * key through the shell's per-daemon client, the way Runtimes reaches them for a profile file. The shell client carries
 * no headers, so the etag travels in the body. A file names a secret only as `${secret:NAME}`; the kernel refuses a raw
 * value, and nothing here reads, shows or writes one.
 *
 * A write that LOOSENS what a ferret may do or spend comes back `pending` with the sentences that wait for the owner.
 * Nothing here confirms it: confirming is the owner's act, not this page's.
 */
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import { z } from 'zod';
import type { PacksClient } from './client.ts';
import type { ConfigText } from './config-text.ts';
import type { ConfigFilePutResult, ConfigFiles, ConfigFileView } from './pack-config.ts';

const NonEmpty = z.string().min(1);

const ConfigFileViewSchema = z.looseObject({ path: NonEmpty, exists: z.boolean(), text: z.string(), etag: NonEmpty });

const ConfigFilePutAnswerSchema = z.looseObject({
  path: NonEmpty,
  etag: NonEmpty,
  outcome: z.enum(['applied', 'pending']),
  pending: z.looseObject({ changes: z.array(NonEmpty) }).optional(),
});

/** The comment-preserving YAML editor, as the `ConfigText` seam: the kernel's own reader and editor. */
const yamlText: ConfigText = {
  read: text => {
    const read = readConfigText(text);
    return read.ok ? { ok: true, value: read.read.value } : { ok: false };
  },
  edit: editConfigText,
};

/** The configuration files of one machine, reached through that machine's client. */
export const createConfigFiles = (client: PacksClient): ConfigFiles => ({
  text: yamlText,
  read: async (path: string): Promise<ConfigFileView> => {
    const file = ConfigFileViewSchema.parse(await client.call('GET /v1/config/file', { query: { path } }));
    return { text: file.text, etag: file.etag };
  },
  write: async (path: string, text: string, etag: string): Promise<ConfigFilePutResult> => {
    const answer = ConfigFilePutAnswerSchema.parse(
      await client.call('PUT /v1/config/file', { body: { path, text, etag } }),
    );
    return answer.outcome === 'pending'
      ? { outcome: 'pending', changes: answer.pending?.changes ?? [] }
      : { outcome: 'applied' };
  },
});
