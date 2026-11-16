/**
 * Codex's part of changing the model, reasoning level or fast mode of a RUNNING ferret (`Harness.runtimeSwitch`).
 *
 * Ferrets owns what is the same for every harness (the idle-prompt rule, the durable request ledger, the re-read of the
 * ferret afterwards) and asks this for what is Codex's own: how a switch is planned, which models its account
 * advertises, how its modal picker is driven, and how a drive that stopped half-way is undone.
 *
 * IT REACHES THE PANE THROUGH ONE THING, {@link RuntimeSwitchPane}: Ferrets' own harness seam for that one ferret, so the
 * runner acts on the pane it owns, Vault's input holds apply and a hold types nothing. There is no tmux address here;
 * what the v4 daemon did against a pane id (read the frame, verify the row, press a digit) is done through that seam.
 */
import type {
  FormKey,
  HarnessRuntimeSwitch,
  RuntimeModelCatalog,
  RuntimeSwitchPane,
  CodexRuntimeCatalogCache as HeldChoices,
} from '@ferretry/core-ferrets/contract';
import { CodexPickerCleanup, defaultPickerCleanupPolicy, type SleepPort } from './cleanup.ts';
import { codexRuntimeCatalog, codexSwitchContext } from './models.ts';
import { fastModeFacts } from './fast-mode.ts';
import { isAddressablePickerKey } from './pane-commands.ts';
import {
  CodexModelPickerDriver,
  CodexPickerDriveError,
  type CodexPickerDrivePort,
  type CodexPickerKeyExpectation,
  type PickerSleeper,
} from './picker-drive.ts';
import { pickerStillShows } from './picker-screen.ts';
import type { CodexPickerPanePort } from './ports.ts';
import { CodexQuirkService } from './quirk-service.ts';

/** The command that opens Codex's own model picker. */
const CODEX_PICKER_COMMAND = '/model';

/** The word the cleanup resolves a pane to: the pane is already bound to ONE ferret, so there is nothing to choose. */
const THIS_FERRET = 'this-ferret';

/** The cleanup's pane (`Escape` until the picker is gone), over the seam. */
class FerretPickerPane implements CodexPickerPanePort {
  constructor(private readonly pane: RuntimeSwitchPane) {}

  async resolvePaneId(): Promise<string> {
    return THIS_FERRET;
  }

  async observe() {
    const frame = await this.pane.observe();
    return { visiblePane: frame.visible, promptReady: frame.promptReady };
  }

  async sendEscape(): Promise<void> {
    await this.pane.key('Escape');
  }
}

/**
 * The picker driver's transport, over the seam. THE VERIFICATION IS NOT ADVISORY: the frame is read again immediately
 * before a digit is pressed, and if it no longer shows the exact row the driver named the key is not sent at all.
 */
export class FerretPickerTransport implements CodexPickerDrivePort {
  constructor(private readonly pane: RuntimeSwitchPane) {}

  async openPicker() {
    return await this.pane.command(CODEX_PICKER_COMMAND);
  }

  async readPane() {
    return await this.pane.observe();
  }

  async sendKey(key: string, expected: CodexPickerKeyExpectation): Promise<void> {
    if (!isAddressablePickerKey(key)) throw new CodexPickerDriveError(`refusing to send ${key} into a Codex picker`);
    if (expected.row.number !== Number(key))
      throw new CodexPickerDriveError('the Codex picker shortcut no longer matches the verified row');
    const frame = await this.pane.observe();
    if (!pickerStillShows(frame.visible, expected))
      throw new CodexPickerDriveError('the Codex picker changed before the verified shortcut could be sent');
    await this.pane.key(key as FormKey);
  }
}

export interface CodexRuntimeSwitchOptions {
  /** The model list Codex's own app-server advertises, held. */
  readonly choices: HeldChoices;
  readonly sleeper: SleepPort;
  /** The CLI a quarantined session tells a human to type. */
  readonly binaryName: string;
}

/** The switch for ONE ferret's pane. Built per request; what it holds is the pane and the one held catalog. */
export function codexRuntimeSwitch(
  options: CodexRuntimeSwitchOptions,
): (pane: RuntimeSwitchPane) => HarnessRuntimeSwitch {
  return pane => ({
    quirks: new CodexQuirkService(
      // `() => true`: the pane is bound to one ferret by the seam, which addresses it by its own handle at every act.
      new CodexPickerCleanup(new FerretPickerPane(pane), options.sleeper, defaultPickerCleanupPolicy, () => true),
      options.binaryName,
    ),
    catalogs: {
      // The catalog is built fresh for each answer and never changed afterwards, so the contract's mutable arrays are safe.
      codexRuntimeCatalog: (choices, account) => codexRuntimeCatalog(choices, account) as RuntimeModelCatalog,
      codexSwitchContext,
      // The planner reads a flat view of the two documents' model facts, not the documents.
      fastModeFacts: (view, catalog) =>
        fastModeFacts(
          {
            ...(view.state.observedModel === undefined ? {} : { observedModel: view.state.observedModel }),
            ...(view.state.observedFast === undefined ? {} : { observedFast: view.state.observedFast }),
            ...(view.config.model === undefined ? {} : { launchModel: view.config.model }),
            ...(view.config.launchFast === undefined ? {} : { launchFast: view.config.launchFast }),
          },
          // Only a Codex session is switched through this, so the catalog it is asked about is Codex's own.
          catalog as Parameters<typeof fastModeFacts>[1],
        ),
      pickerDriver: (sleeper: PickerSleeper) => new CodexModelPickerDriver(new FerretPickerTransport(pane), sleeper),
    },
    liveCatalog: options.choices,
  });
}
