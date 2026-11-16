import { deliverPart } from './deliver.ts';
import { dialogsPart } from './dialogs.ts';
import { historyPart } from './history.ts';
import { homePart } from './home.ts';
import { identityPart } from './identity.ts';
import { launchSettingsPart } from './launch-settings.ts';
import { lifecyclePart } from './lifecycle.ts';
import { runtimeSwitchPart } from './runtime-switch.ts';
import { transcriptPart } from './transcript.ts';
import { usagePart } from './usage.ts';

/**
 * The parts the Claude harness is composed of: ONE entry per line, sorted, each with its own trailing comma, so two parts
 * added at once merge without a conflict. A new part is a new file here plus one import and one entry below.
 */
export const CLAUDE_PARTS = [
  deliverPart,
  dialogsPart,
  historyPart,
  homePart,
  identityPart,
  launchSettingsPart,
  lifecyclePart,
  runtimeSwitchPart,
  transcriptPart,
  usagePart,
] as const;
