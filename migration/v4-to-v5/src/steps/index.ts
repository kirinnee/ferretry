/**
 * The conversions, in the owner's order of importance (brief item 5). Each step reads v4 files with this tool's own
 * parsers and writes v5 files through `V5Writer` with the schema its v5 owner declares.
 *
 * A step whose v5 owner has not landed its state schema yet is `pending` and names what it waits for. A step
 * becomes real by replacing its `run` (the Vault and identity steps are real: `./secrets.ts`) — the table, the order and the not-carried list stay. While any step is
 * pending, `home.json` is not written and v5 refuses the folder: an incomplete conversion cannot be booted.
 */
import type { V4ConfigOverrides, V4Paths } from '../v4/layout.ts';
import type { LoginHarness } from './preview-hold.ts';
import type { V5Writer } from '../v5/write.ts';
import type { NotCarried, StepReport } from '../report.ts';
import { accessStep } from './access.ts';
import { accountsStep } from './accounts.ts';
import { archiveSettingStep } from './archive-setting.ts';
import { agendaStep } from './agenda.ts';
import { boardStep } from './board.ts';
import { acceptedConfigStep } from './accepted-config.ts';
import { catalogsStep } from './catalogs.ts';
import { skillFoldersStep } from './skill-folders.ts';
import { conversationStep } from './conversation.ts';
import { daemonSettingsStep } from './daemon-settings.ts';
import { ferretConversationsStep } from './ferret-conversations.ts';
import { ferretsStep } from './ferrets.ts';
import { gateStep } from './gate.ts';
import { harnessHomesStep } from './harness-homes.ts';
import { lessonsStep } from './lessons.ts';
import { loginKeysStep, type LoginKeyHold } from './login-keys.ts';
import { loginsStep } from './logins.ts';
import { mcpStep } from './mcp.ts';
import { packsStep } from './packs.ts';
import { projectsStep } from './projects.ts';
import { settingsStep } from './settings.ts';
import { terminalsStep } from './terminals.ts';
import { identityStep, vaultStep } from './secrets.ts';
import { usageStep } from './usage.ts';
import { wardenStep } from './warden.ts';

/** What the converter may read about the machine it runs on, beyond the v4 home: injected so tests never touch a real home. */
export interface HostFacts {
  readonly homeDirectory: string;
  /** `XDG_CONFIG_HOME` when set. */
  readonly configHome?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** What the plain dry pass over the v4 home (with config overrides) produced. */
export interface EnforcedConversion {
  /** Every config file (`config/…` path to text) it would write. */
  readonly configs: ReadonlyMap<string, string>;
  /** The config-writing steps that failed in it (their files are missing from `configs`). */
  readonly failed: readonly string[];
  /** One line per failed step: its id and its own note (names a file and a key, never a value). */
  readonly failedWhy: readonly string[];
  /** What it took out of one login's file (see `LoginKeyHold.fingerprint`): digests, never a value. */
  readonly fingerprint: (login: string) => string;
}

export interface StepContext {
  readonly v4: V4Paths;
  readonly v5: V5Writer;
  readonly dryRun: boolean;
  /** The try-it preview (see `ConvertOptions.preview`): carry nothing that points into, or authenticates against, v4. */
  readonly preview?: boolean;
  /** With `preview`: the real v4 home the staged copy came from (see `ConvertOptions.previewV4Home`). */
  readonly previewV4Home?: string;
  /** With `preview`: the environment every preview ferret's shells get (see `ConvertOptions.previewShellEnv`). */
  readonly previewShellEnv?: Readonly<Record<string, string>>;
  /**
   * With `preview`: the OWNER ran `prepare --owner`, so the preview's own authored files are recorded as accepted
   * (the owner's act). Absent: nothing of the preview's own is accepted.
   */
  readonly previewOwner?: boolean;
  /**
   * With `preview`: login name to the ONE harness its v4 login file names (`claude` or `codex`), picked by the stage
   * through a schema that reads only that field, plus whether it drives both CLIs (halves for both). An unreadable
   * login is absent. Nothing else of a login file ever reaches this.
   */
  readonly previewLoginHarnesses?: ReadonlyMap<string, LoginHarness>;
  /** With `preview`: the user's real home folder, so a component's `~/…` file is mapped into the staged copy. */
  readonly previewUserHome?: string;
  /**
   * The person running the conversion chose to drop every layer that names a settings or hooks component this tool
   * cannot carry (the ferrets may then be LESS restricted than in v4). Never the default; an agent never sets it.
   */
  readonly dropUncarried?: boolean;
  /**
   * With `preview`: every config file (`config/…` path to text) the PLAIN, non-preview conversion of the same v4 home
   * writes. A config file whose text the preview wrote or changed differs from it (or is absent from it), and is
   * "preview-authored". Absent in a preview run: nothing is known to be unchanged, so every file counts as authored.
   */
  readonly plainConfigs?: ReadonlyMap<string, string>;
  /**
   * The plain, non-preview dry conversion of a v4 home laid out like the real one: every config file (`config/…` path to
   * text) it would write. The accepted-config step runs it on a VIEW of v4 as v4 enforced it. Absent: what v4 enforced
   * cannot be converted, so nothing is recorded for a held v4 file (fail closed).
   */
  readonly dryConfigs?: (overrides: V4ConfigOverrides) => Promise<EnforcedConversion>;
  /** Absent in tests that do not read the host: a step needing it then reads nothing and says so. */
  readonly host?: HostFacts;
  /**
   * Plain keys the Settings step took out of login files, waiting for the login-keys step to seal them in the vault.
   * Absent: a login file holding a plain key then fails Settings, as it did before this existed (never left plain).
   */
  readonly loginKeys?: LoginKeyHold;
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

/** A step whose v5 schema has not landed: it reports `pending`, so the run exits 3 and writes no `home.json`. */
export function pending(step: Omit<Step, 'run'>, waitsFor: string): Step {
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
  // After Ferrets and Harness folders: each ferret's conversation goes into its own agent home, beside the pool copy.
  ferretConversationsStep,
  boardStep,
  agendaStep,
  projectsStep,
  lessonsStep,
  usageStep,
  wardenStep,
  catalogsStep,
  // The folders the install records carried by Catalogs name.
  skillFoldersStep,
  settingsStep,
  daemonSettingsStep,
  archiveSettingStep,
  // After Settings and Daemon settings: config/pack.yaml, models-guide.yaml and routing.json are this step's alone.
  packsStep,
  loginsStep,
  vaultStep,
  // After the vault step: it adds entries to the vault the step above moved (and mints its key if v4 had none).
  loginKeysStep,
  // After the vault: MCP's sealed document is opened by the key the vault step moves (once).
  mcpStep,
  identityStep,
  // After the vault: Accounts' sealed values are opened by the same key the vault step moves (once).
  accountsStep,
  accessStep,
  gateStep,
  // Last: it records as accepted every config file the steps above wrote.
  acceptedConfigStep,
];
