import type { ConfigCollectionDef, ConfigPort } from '@ferretry/kernel/contract';
import type { McpItem } from '../../../contract/index.ts';
import type { McpConfigWrite } from './ports.ts';

export { hostImportPut } from './put.ts';

/** The kernel's config service as the import's write: create-only, as the person's act (a held answer is a held answer). */
export function kernelConfigWrite(config: ConfigPort, def: ConfigCollectionDef<McpItem>): McpConfigWrite {
  return {
    taken: name => config.fileState(def, name).state !== 'absent',
    create: async (name, documentText) => await config.writeAsCaller(def, name, documentText, { ifMatch: 'absent' }),
    etag: async name => await config.etag(def, name),
    replace: async (name, documentText, ifMatch) => await config.writeAsCaller(def, name, documentText, { ifMatch }),
  };
}
