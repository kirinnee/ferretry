/**
 * What Codex hands Runtimes for its own runtime behaviour (`RuntimesHarnessKit`, offered through the settings source in
 * `../profile-components.ts`). One file per group; each move fills only its own file, so no later move edits this one.
 */
import type { RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';
import { codexCredentialsKit } from './credentials.ts';
import { codexFixedLayerKit } from './fixed-layer.ts';
import { codexImportKit } from './import.ts';
import { codexMcpKit } from './mcp.ts';
import { codexWordsKit } from './words.ts';
import { codexWrapperKit } from './wrapper.ts';

export const codexRuntimesKit: RuntimesHarnessKit = {
  ...codexFixedLayerKit,
  ...codexCredentialsKit,
  ...codexMcpKit,
  ...codexWrapperKit,
  ...codexImportKit,
  ...codexWordsKit,
};
