/**
 * What Claude Code hands Runtimes for its own runtime behaviour (`RuntimesHarnessKit`, offered through the settings
 * source in `../profile-components.ts`). One file per group; each move fills only its own file, so no later move edits
 * this one.
 */
import type { RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';
import { claudeCredentialsKit } from './credentials.ts';
import { claudeFixedLayerKit } from './fixed-layer.ts';
import { claudeImportKit } from './import.ts';
import { claudeMcpKit } from './mcp.ts';
import { claudeWordsKit } from './words.ts';
import { claudeWrapperKit } from './wrapper.ts';

export const claudeRuntimesKit: RuntimesHarnessKit = {
  ...claudeFixedLayerKit,
  ...claudeCredentialsKit,
  ...claudeMcpKit,
  ...claudeWrapperKit,
  ...claudeImportKit,
  ...claudeWordsKit,
};
