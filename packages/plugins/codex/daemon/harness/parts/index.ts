/**
 * The registry of the Codex harness's parts: one import and one entry per line, sorted by name, each entry ending in
 * its own comma. A part owns its members (each `Harness` member lives in exactly one part); to add one, add a file here
 * plus one import line and one entry line below. `codex-harness.ts` composes them and a unit test pins member -> part.
 */
import { conversationPart } from './conversation.ts';
import { credentialsPart } from './credentials.ts';
import { deliverPart } from './deliver.ts';
import { discoverPart } from './discover.ts';
import { historyPart } from './history.ts';
import { homePart } from './home.ts';
import { identityPart } from './identity.ts';
import { injectPart } from './inject.ts';
import { launchSettingsPart } from './launch-settings.ts';
import { lifecyclePart } from './lifecycle.ts';
import { runtimeSwitchPart } from './runtime-switch.ts';
import { startFailurePart } from './start-failure.ts';
import { transcriptPart } from './transcript.ts';

export const CODEX_HARNESS_PARTS = [
  conversationPart,
  credentialsPart,
  deliverPart,
  discoverPart,
  historyPart,
  homePart,
  identityPart,
  injectPart,
  launchSettingsPart,
  lifecyclePart,
  runtimeSwitchPart,
  startFailurePart,
  transcriptPart,
] as const;
