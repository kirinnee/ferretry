/**
 * `FerretsApi.runtimeControl`: the runtime-control service (`./service.ts`), offered over a ferret's own harness seam and its
 * harness plugin's own part (`Harness.runtimeSwitch`).
 *
 * THE SERVICE IS BUILT PER REQUEST, from what that ONE ferret's harness provides, so Ferrets never names a harness and
 * a new harness that supplies `runtimeSwitch` is served without any edit here. What is shared across requests is exactly
 * what must be: the per-session serial queue (two drives into one modal is the failure it prevents), the durable effect
 * ledger and the plugin's own held catalog. A harness with no `runtimeSwitch` answers `unsupported`.
 *
 * NO PANE HANDLE AND NO TMUX ADDRESS appears below. The service was written against a tmux session name; here the name
 * is the ferret's own id and means nothing but "this ferret", and every act on the pane is the ferret's runner acting
 * through the harness seam (so Vault's input holds apply and a hold types nothing).
 *
 * WHO MAY SWITCH WHOSE: asking the seam for the ferret is the authorization. A person (no `caller`) reaches any ferret; a
 * ferret reaches itself and its helpers (its descendants), never its lead, and `FerretsService.harness` refuses anyone else with a 403 `forbidden`
 * before anything else is read. It is checked here, not in the route, so every transport gets the same rule.
 */
import {
  PICKER_KEYS,
  RuntimeControlError,
  type FerretHarness,
  type FerretId,
  type FerretView,
  type HarnessRuntimeSwitch,
  type PickerKey,
  type RuntimeControlApi,
  type RuntimeControlRequest,
  type RuntimeModelCatalog,
  type RuntimeSwitchFrame,
  type RuntimeSwitchPane,
} from '../../../../contract/index.ts';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import { parseSessionId, type SessionId } from '../../session-id.ts';
import type { SessionEffectLedger } from '../effects/types.ts';
import type { AccountInventoryPort } from '../peers/core.ts';
import type { CodexRuntimeCatalogCache, HarnessRuntimeCatalogs, PickerSleeper } from '../peers/harness.ts';
import { HARNESS_PICKER_COMMAND, SessionRuntimeControlService, type SessionRuntimeControlPorts } from './service.ts';
import {
  SessionRuntimeError,
  type RuntimePane,
  type RuntimeQuarantinePatch,
  type RuntimePickerTransport,
} from './types.ts';

/** What Ferrets hands the control: how to reach one ferret, its harness's switch, and the shared session machinery. */
export interface FerretRuntimeControlDeps {
  /** The ferret an id or a name addresses, or none: asked once the held records are loaded, never before. */
  readonly resolve: (reference: string) => Promise<FerretId | undefined>;
  /** The harness seam of one ferret, `mayTouch` applied for a `caller` (a 403 `forbidden` otherwise); none for an unknown ferret. */
  readonly seam: (ferret: FerretId, caller: FerretId | undefined) => Promise<FerretHarness | undefined>;
  /** The ferret's harness's own part of the switch, built for its pane; none when that harness offers none. */
  readonly runtimeSwitchOf: (ferret: FerretId) => ((pane: RuntimeSwitchPane) => HarnessRuntimeSwitch) | undefined;
  /** The ferret as every other surface reads it. */
  readonly view: (id: SessionId) => Promise<FerretView | undefined>;
  readonly journal: (id: SessionId, event: string, data: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly quarantine: (id: SessionId, patch: RuntimeQuarantinePatch) => Promise<void>;
  readonly effects: (id: SessionId) => SessionEffectLedger;
  /** Stops a ferret whose per-ferret key the caller ALREADY HOLDS (the control holds it while it drives). */
  readonly stopHeld: (ferret: FerretId) => Promise<void>;
  readonly serial: SerialExecutor;
  readonly accounts: AccountInventoryPort;
  readonly clock: ClockPort;
  readonly sleeper: PickerSleeper;
  /** The CLI a quarantined session tells a human to type. */
  readonly clientName: string;
}

/** A refusal the harness seam answered, as one sentence; the closed code only, never pane text. */
function refusalSentence(failure: unknown): string {
  if (typeof failure === 'object' && failure !== null) {
    if ('unconfirmed' in failure) return 'it may have reached the pane but was not proved to';
    if ('refused' in failure && typeof failure.refused === 'string') return `refused: ${failure.refused}`;
  }
  return 'it could not be done';
}

/**
 * ONE ferret's pane as a harness's runtime switch reaches it: the harness seam's own form and delivery acts, and nothing
 * more. Reads are the seam's capture (masked); a missing `form` is the runner being off.
 */
export function ferretRuntimePane(seam: FerretHarness, stop: () => Promise<void>): RuntimeSwitchPane {
  const form = seam.form;
  const unavailable = (): never => {
    throw new SessionRuntimeError('refused', "the runner that owns this ferret's terminal is off");
  };
  return {
    observe: async (): Promise<RuntimeSwitchFrame> => {
      if (form === undefined) return unavailable();
      const captured = await form.capture();
      if (!captured.ok) throw new Error(`the pane could not be read (${refusalSentence(captured.error)})`);
      const { alive, dead, promptReady, activeWork, blocking, visible } = captured.value;
      // A pane mid-turn, or parked on a dialog, is not at an idle prompt: a control is refused rather than queued.
      return { alive, dead, promptReady: promptReady && !activeWork && blocking === undefined, visible };
    },
    command: async text => {
      const delivered = await seam.deliver({ text });
      if (!delivered.ok) throw new Error(`the command could not be typed (${refusalSentence(delivered.error)})`);
      return delivered.value;
    },
    key: async key => {
      if (form === undefined) return unavailable();
      const pressed = await form.key(key);
      if (!pressed.ok) throw new Error(`the key could not be pressed (${refusalSentence(pressed.error)})`);
    },
    pickerKey: async key => {
      const press = form?.pickerKey;
      if (form === undefined || press === undefined) return unavailable();
      const pressed = await press(key);
      if (!pressed.ok) throw new Error(`the key could not be pressed (${refusalSentence(pressed.error)})`);
    },
    stop,
  };
}

/** What the service needs where a harness gave nothing: a refusal that reads as the harness not offering it. */
function lacking(what: string): never {
  throw new SessionRuntimeError('unsupported', `this ferret's harness does not offer ${what}`);
}

/** The service's whole catalog seam, from the members this harness supplied. */
function catalogsOf(supplied: HarnessRuntimeSwitch['catalogs']): HarnessRuntimeCatalogs {
  return {
    claudeRuntimeCatalog: () => lacking('a model catalog'),
    codexRuntimeCatalog: (choices, account) =>
      supplied.codexRuntimeCatalog === undefined
        ? lacking('a live model catalog')
        : supplied.codexRuntimeCatalog(choices, account),
    codexSwitchContext: choices =>
      supplied.codexSwitchContext === undefined
        ? lacking('a live model catalog')
        : supplied.codexSwitchContext(choices),
    fastModeFacts: (view, catalog) =>
      supplied.fastModeFacts === undefined ? lacking('a fast mode') : supplied.fastModeFacts(view, catalog),
    pickerDriver: (transport, sleeper) =>
      supplied.pickerDriver === undefined ? lacking('a model picker') : supplied.pickerDriver(transport, sleeper),
  };
}

/** A harness with no held catalog has no live models to list. */
const NO_LIVE_CATALOG: CodexRuntimeCatalogCache = {
  get: async () => lacking('a live model catalog'),
};

/**
 * The picker transport over ONE ferret's pane: open the picker with the harness's own command, read a frame, press a row's
 * digit. It does the pane's part only. Whether the row a digit is aimed at is STILL on screen is the harness's own
 * knowledge of its picker, so a harness's `pickerDriver` wraps this and proves the row before it lets a digit through.
 * Only the closed `PICKER_KEYS` can be pressed.
 */
function pickerTransportOf(pane: RuntimeSwitchPane): RuntimePickerTransport {
  return () => ({
    openPicker: async () => await pane.command(HARNESS_PICKER_COMMAND),
    readPane: async () => await pane.observe(),
    sendKey: async key => {
      if (!(PICKER_KEYS as readonly string[]).includes(key))
        throw new Error(`${key} is not a key a picker is driven with`);
      await pane.pickerKey(key as PickerKey);
    },
  });
}

/** What the service reads of a ferret to address its pane: its account's executable and the folder it works in. */
const launchTargetOf = (ferret: FerretId, view: FerretView) => ({
  tmuxSession: ferret,
  agent: view.config.agent,
  cwd: view.config.cwd,
});

export class FerretRuntimeControl implements NonNullable<RuntimeControlApi['runtimeControl']> {
  constructor(private readonly deps: FerretRuntimeControlDeps) {}

  async models(caller: FerretId | undefined, target: string): Promise<RuntimeModelCatalog> {
    const { ferret, service } = await this.#open(caller, target);
    return await this.#refused(async () => await service.models(ferret));
  }

  async control(
    caller: FerretId | undefined,
    target: string,
    request: RuntimeControlRequest,
    requestId: string,
  ): Promise<FerretView> {
    const { ferret, service } = await this.#open(caller, target);
    return await this.#refused(async () => await service.control(ferret, request, requestId));
  }

  /** The service for one ferret, or the refusal that says why there is none. */
  async #open(
    caller: FerretId | undefined,
    reference: string,
  ): Promise<{ readonly ferret: FerretId; readonly service: SessionRuntimeControlService }> {
    const ferret = await this.deps.resolve(reference);
    if (ferret === undefined) throw new RuntimeControlError('not_found', `no session ${reference}`);
    // THE AUTHORIZATION: a ferret caller that may not touch this ferret is refused here, before anything is read.
    const seam = await this.deps.seam(ferret, caller);
    if (seam === undefined) throw new RuntimeControlError('not_found', `no session ${reference}`);
    const build = this.deps.runtimeSwitchOf(ferret);
    if (build === undefined)
      throw new RuntimeControlError(
        'unsupported',
        "this ferret's harness cannot have its model, effort or fast mode changed while it runs",
      );
    const pane = ferretRuntimePane(seam, async () => await this.deps.stopHeld(ferret));
    const harness = build(pane);
    return { ferret, service: new SessionRuntimeControlService(this.#ports(ferret, pane, harness)) };
  }

  #ports(ferret: FerretId, pane: RuntimeSwitchPane, harness: HarnessRuntimeSwitch): SessionRuntimeControlPorts {
    const { deps } = this;
    const id = parseSessionId(ferret);
    const runtimePane: RuntimePane = {
      state: async () => {
        const frame = await pane.observe();
        return { alive: frame.alive, dead: frame.dead, promptReady: frame.promptReady };
      },
      stop: async () => await pane.stop(),
    };
    return {
      repository: {
        // The reference is the ferret already resolved, so it is a session or it is nothing.
        find: () => ({ kind: 'session', id }),
        view: async found => await deps.view(found),
        launch: async found => {
          const view = await deps.view(found);
          // The "tmux session" is the ferret's own id: every act on the pane goes through the seam bound to it.
          return view === undefined ? undefined : launchTargetOf(ferret, view);
        },
        journal: deps.journal,
        quarantine: deps.quarantine,
      },
      effects: deps.effects(id),
      pane: runtimePane,
      injector: { deliver: async (_session, command) => await pane.command(command) },
      picker: pickerTransportOf(pane),
      harness: harness.quirks,
      catalogs: catalogsOf(harness.catalogs),
      accounts: deps.accounts,
      catalog: harness.liveCatalog ?? NO_LIVE_CATALOG,
      serial: deps.serial,
      sleeper: deps.sleeper,
      clock: deps.clock,
      clientName: deps.clientName,
    };
  }

  /** The service's own refusal, restated in the contract's. Anything else is not a refusal and goes on as it came. */
  async #refused<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SessionRuntimeError) throw new RuntimeControlError(error.failure, error.message);
      throw error;
    }
  }
}
