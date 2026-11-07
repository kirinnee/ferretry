/**
 * The conversions, in the owner's order of importance (brief item 5). Each step reads v4 files with this tool's own
 * parsers and writes v5 files through `V5Writer` with the schema its v5 owner declares.
 *
 * A step whose v5 owner has not landed its state schema yet is `pending` and names what it waits for. A step
 * becomes real by replacing its `run` (the Vault and identity steps are real: `./secrets.ts`) — the table, the order and the not-carried list stay. While any step is
 * pending, `home.json` is not written and v5 refuses the folder: an incomplete conversion cannot be booted.
 */
import type { V4Paths } from '../v4/layout.ts';
import type { V5Writer } from '../v5/write.ts';
import type { NotCarried, StepReport } from '../report.ts';
import { accessStep } from './access.ts';
import { accountsStep } from './accounts.ts';
import { agendaStep } from './agenda.ts';
import { boardStep } from './board.ts';
import { catalogsStep } from './catalogs.ts';
import { conversationStep } from './conversation.ts';
import { daemonSettingsStep } from './daemon-settings.ts';
import { ferretsStep } from './ferrets.ts';
import { gateStep } from './gate.ts';
import { harnessHomesStep } from './harness-homes.ts';
import { lessonsStep } from './lessons.ts';
import { loginsStep } from './logins.ts';
import { mcpStep } from './mcp.ts';
import { packsStep } from './packs.ts';
import { projectsStep } from './projects.ts';
import { settingsStep } from './settings.ts';
import { terminalsStep } from './terminals.ts';
import { identityStep, vaultStep } from './secrets.ts';
import { usageStep } from './usage.ts';
import { wardenStep } from './warden.ts';

export interface StepContext {
  readonly v4: V4Paths;
  readonly v5: V5Writer;
  readonly dryRun: boolean;
}

export interface Step {
  readonly id: string;
  readonly title: string;
  /** The v5 owner whose declared files this step writes (§9.2 of docs/design/redesign.md). */
  readonly owner: readonly string[];
  /** The v4 sources, relative to the v4 home (docs/migration/v4-formats.md has the full rows). */
  readonly reads: readonly string[];
  /** Files moved byte for byte, never opened. */
  readonly sealed: readonly string[];
  readonly notCarried: readonly NotCarried[];
  readonly run: (ctx: StepContext) => Promise<StepReport>;
}

function pending(step: Omit<Step, 'run'>, waitsFor: string): Step {
  return {
    ...step,
    run: async () => ({
      id: step.id,
      title: step.title,
      status: 'pending',
      note: `waits for ${waitsFor}`,
      kept: [],
      notCarried: step.notCarried,
      sealed: [],
    }),
  };
}

export const STEPS: readonly Step[] = [
  ferretsStep,
  conversationStep,
  terminalsStep,
  harnessHomesStep,
  boardStep,
  agendaStep,
  projectsStep,
  lessonsStep,
  usageStep,
  wardenStep,
  catalogsStep,
  settingsStep,
  daemonSettingsStep,
  // After Settings and Daemon settings: config/pack.yaml, models-guide.yaml and routing.json are this step's alone.
  packsStep,
  loginsStep,
  vaultStep,
  // After the vault: MCP's sealed document is opened by the key the vault step moves (once).
  mcpStep,
  identityStep,
  // After the vault: Accounts' sealed values are opened by the same key the vault step moves (once).
  accountsStep,
  accessStep,
  gateStep,
];
