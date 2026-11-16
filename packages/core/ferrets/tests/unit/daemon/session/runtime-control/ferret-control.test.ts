import { describe, it } from 'bun:test';
import should from 'should';
import { ApiError } from '@ferretry/kernel/contract';
import {
  type FerretHarness,
  type FerretId,
  type HarnessRuntimeSwitch,
  type RuntimeControlRequest,
  type RuntimeSwitchPane,
  type CodexPickerKeyExpectation,
  type RuntimeSwitchPlan,
  RuntimeControlError,
} from '../../../../../contract/index.ts';
import {
  FerretRuntimeControl,
  type FerretRuntimeControlDeps,
  ferretRuntimePane,
} from '../../../../../daemon/lib/session/runtime-control/ferret-control.ts';
import type { RuntimeQuarantinePatch } from '../../../../../daemon/lib/session/runtime-control/types.ts';
import { CODEX_VIEW, FakeSessionEffectLedger, NOW, RecordingSerial } from './support.ts';

/**
 * The runtime control OVER A FERRET: what Ferrets adds to the ported service. The service's own decisions (the four
 * preconditions, the ledger, the picker, the quarantine order) are proved in `service.test.ts` against the same service;
 * here it is proved that a ferret reaches it through its own harness seam and its harness's own `runtimeSwitch`, that
 * who may switch whose ferret is decided before anything is read, and that a harness that offers none is refused.
 */

const FERRET = 's1' as FerretId;
const STRANGER = 'stranger' as FerretId;

/** What a pane shows: an idle prompt, or visibly mid-turn, or parked on a dialog. */
interface Screen {
  readonly promptReady: boolean;
  readonly activeWork: boolean;
  readonly blocking?: 'permission' | 'dialog';
}
const IDLE: Screen = { promptReady: true, activeWork: false };

/** A ferret's harness seam that records what was typed and pressed. */
function seamOf(screen: () => Screen, typed: string[], pressed: string[], outcome: 'handled-local' | 'turn-started') {
  return {
    deliver: async (delivery: { readonly text: string }) => {
      typed.push(delivery.text);
      return { ok: true as const, value: outcome };
    },
    form: {
      capture: async () => ({
        ok: true as const,
        value: { alive: true, dead: false, history: '', visible: 'the pane', ...screen() },
      }),
      key: async (key: string) => {
        pressed.push(key);
        return { ok: true as const, value: undefined };
      },
      pickerKey: async (key: string) => {
        pressed.push(key);
        return { ok: true as const, value: undefined };
      },
      paste: async () => ({ ok: true as const, value: undefined }),
    },
  } as unknown as FerretHarness;
}

/** What a test's harness plans, and which of its catalog members it supplies. */
interface SwitchOptions {
  readonly plan?: RuntimeSwitchPlan;
  /** `none`: a harness that supplies a live catalog but none of the projections the service asks for. */
  readonly catalogs?: 'full' | 'none';
  readonly keys?: string[];
}

const KEY_ROW: CodexPickerKeyExpectation = { kind: 'quick-models', row: { number: 2, name: 'two' } };

/** A harness's switch that plans what a command-switched harness plans, and records its own use. */
function switchOf(
  calls: { planned: unknown[]; built: number },
  options: SwitchOptions = {},
): (pane: RuntimeSwitchPane) => HarnessRuntimeSwitch {
  return () => {
    calls.built += 1;
    return {
      quirks: {
        planSwitch: request => {
          calls.planned.push(request);
          return options.plan ?? { kind: 'inject', command: '/model', claimsOutcome: false };
        },
        recoverFromFailedDrive: async () => ({ kind: 'recovered' }),
        report: () => 'a report',
      },
      catalogs:
        options.catalogs === 'none'
          ? {}
          : {
              codexRuntimeCatalog: choices => ({ harness: 'codex', source: 'codex-app-server', choices: [...choices] }),
              codexSwitchContext: () => ({ choices: [] }),
              fastModeFacts: () => ({ supported: true, current: false }),
              // A driver that uses the pane transport Ferrets built, the way a harness's real one does.
              pickerDriver: transport => ({
                drive: async () => {
                  await transport.openPicker();
                  await transport.readPane();
                  await transport.sendKey('2', KEY_ROW);
                  options.keys?.push('driven');
                  await transport.sendKey('y', KEY_ROW);
                },
              }),
            },
      liveCatalog: {
        get: async () => [{ value: 'gpt-6', label: 'GPT 6', reasoningEfforts: [{ value: 'high' }] }],
      },
    };
  };
}

interface World {
  control: FerretRuntimeControl;
  readonly typed: string[];
  readonly pressed: string[];
  readonly seamCallers: (FerretId | undefined)[];
  readonly journal: { readonly event: string; readonly data: Readonly<Record<string, unknown>> }[];
  readonly quarantines: RuntimeQuarantinePatch[];
  readonly stopped: FerretId[];
  readonly switched: { planned: unknown[]; built: number };
  readonly views: { reads: number };
  screen: Screen;
}

const world = (
  options: {
    readonly offers?: boolean;
    readonly outcome?: 'handled-local' | 'turn-started';
    readonly viewAnswer?: 'present' | 'missing';
    readonly switchOptions?: SwitchOptions;
    readonly journalFails?: boolean;
  } = {},
): World => {
  const state: World = {
    typed: [],
    pressed: [],
    seamCallers: [],
    journal: [],
    quarantines: [],
    stopped: [],
    switched: { planned: [], built: 0 },
    views: { reads: 0 },
    screen: IDLE,
    control: undefined as never,
  };
  const effects = new FakeSessionEffectLedger();
  const seam = seamOf(() => state.screen, state.typed, state.pressed, options.outcome ?? 'handled-local');
  const deps: FerretRuntimeControlDeps = {
    resolve: async reference => (reference === 's1' || reference === 'alice' ? FERRET : undefined),
    seam: async (ferret, caller) => {
      state.seamCallers.push(caller);
      // Ferrets' own rule, as `FerretsService.harness` applies it: a ferret reaches itself, and nobody else.
      if (caller !== undefined && caller !== ferret)
        throw new ApiError(403, `a ferret acts only on itself and its helpers, and ${ferret} is neither`, 'forbidden');
      return seam;
    },
    runtimeSwitchOf: () => (options.offers === false ? undefined : switchOf(state.switched, options.switchOptions)),
    view: async () => {
      state.views.reads += 1;
      return options.viewAnswer === 'missing' ? undefined : CODEX_VIEW();
    },
    journal: async (_id, event, data) => {
      if (options.journalFails === true) throw new Error('the journal is not writable');
      state.journal.push({ event, data });
    },
    quarantine: async (_id, patch) => {
      state.quarantines.push(patch);
    },
    effects: () => effects,
    stopHeld: async ferret => {
      state.stopped.push(ferret);
    },
    serial: new RecordingSerial(),
    accounts: { accounts: async () => [] },
    clock: { now: () => NOW },
    sleeper: { sleep: async () => undefined },
    clientName: 'fy',
  };
  state.control = new FerretRuntimeControl(deps);
  return state;
};

/** The refusal a call ended in, whatever its class, so a test names the taxonomy it expects. */
async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to be refused and was not');
}

const MODEL: RuntimeControlRequest = { action: 'model' };

describe('the runtime control over a ferret', () => {
  describe('who may switch whose ferret', () => {
    it('lets a person switch any ferret: no caller is nobody, and nothing narrows it', async () => {
      const w = world();
      await w.control.control(undefined, 's1', MODEL, 'request-1');
      should(w.seamCallers).eql([undefined]);
      should(w.typed).eql(['/model']);
    });

    it('lets a ferret switch itself', async () => {
      const w = world();
      await w.control.control(FERRET, 's1', MODEL, 'request-1');
      should(w.typed).eql(['/model']);
    });

    it('refuses a ferret that is neither the target nor an ancestor of it, before anything is read or typed', async () => {
      const w = world();
      const refused = await refusal(w.control.control(STRANGER, 's1', MODEL, 'request-1'));
      should(refused).be.instanceOf(ApiError);
      should((refused as ApiError).status).equal(403);
      should((refused as ApiError).code).equal('forbidden');
      should(w.views.reads).equal(0);
      should(w.switched.built).equal(0);
      should(w.typed).eql([]);
    });

    it('refuses the same stranger the model list too: the catalog is not for anyone who may not touch the ferret', async () => {
      const w = world();
      const refused = await refusal(w.control.models(STRANGER, 's1'));
      should((refused as ApiError).status).equal(403);
      should(w.views.reads).equal(0);
    });

    it('addresses a ferret by its name as by its id', async () => {
      const w = world();
      await w.control.control(undefined, 'alice', MODEL, 'request-1');
      should(w.typed).eql(['/model']);
    });
  });

  describe('what is refused as the contract names it', () => {
    it('answers not_found for a ferret nobody holds, before asking the seam', async () => {
      const w = world();
      const refused = await refusal(w.control.control(undefined, 'nobody', MODEL, 'request-1'));
      should(refused).be.instanceOf(RuntimeControlError);
      should((refused as RuntimeControlError).failure).equal('not_found');
      should(w.seamCallers).eql([]);
    });

    it('answers unsupported for a harness that offers no runtimeSwitch, and types nothing', async () => {
      const w = world({ offers: false });
      const control = await refusal(w.control.control(undefined, 's1', MODEL, 'request-1'));
      should((control as RuntimeControlError).failure).equal('unsupported');
      const models = await refusal(w.control.models(undefined, 's1'));
      should((models as RuntimeControlError).failure).equal('unsupported');
      should(w.typed).eql([]);
    });

    it("restates the service's own refusals in the contract's, with the same code and sentence", async () => {
      const w = world();
      w.screen = { promptReady: true, activeWork: true };
      const refused = await refusal(w.control.control(undefined, 's1', MODEL, 'request-1'));
      should(refused).be.instanceOf(RuntimeControlError);
      should((refused as RuntimeControlError).failure).equal('refused');
      should((refused as RuntimeControlError).message).match(/idle prompt/u);
      should(w.typed).eql([]);
    });

    it('answers failed, not unsupported, when the harness read the command as a message', async () => {
      const w = world({ outcome: 'turn-started' });
      const refused = await refusal(w.control.control(undefined, 's1', MODEL, 'request-1'));
      should((refused as RuntimeControlError).failure).equal('failed');
    });
  });

  describe('the ferret, through its own seam', () => {
    it('types the harness-planned native command and answers the ferret as it stands afterwards', async () => {
      const w = world();
      const view = await w.control.control(undefined, 's1', MODEL, 'request-1');
      should(w.typed).eql(['/model']);
      should(w.switched.planned).eql([{ harness: 'codex' }]);
      should(view.config.id).equal('s1');
      should(w.journal.map(entry => entry.event)).eql(['control.runtime_model']);
    });

    it('is idempotent on the request id: a retry is answered from the ledger and types nothing again', async () => {
      const w = world();
      await w.control.control(undefined, 's1', MODEL, 'request-1');
      await w.control.control(undefined, 's1', MODEL, 'request-1');
      should(w.typed).eql(['/model']);
    });

    it('refuses the same request id spent on a DIFFERENT control rather than replaying the first', async () => {
      const w = world();
      await w.control.control(undefined, 's1', MODEL, 'request-1');
      const refused = await refusal(w.control.control(undefined, 's1', { action: 'compact' }, 'request-1'));
      should((refused as RuntimeControlError).failure).equal('conflict');
      should(w.typed).eql(['/model']);
    });

    it('reads the model list from the harness catalog it supplied', async () => {
      const w = world();
      const catalog = await w.control.models(undefined, 's1');
      should(catalog.harness).equal('codex');
      should(catalog.choices.map(choice => choice.value)).eql(['gpt-6']);
    });

    it('lets a failure that is not a refusal go on as it came, never dressed as one', async () => {
      const w = world({ journalFails: true });
      const failure = await refusal(w.control.control(undefined, 's1', MODEL, 'request-1'));
      should(failure).not.be.instanceOf(RuntimeControlError);
      should((failure as Error).message).equal('the journal is not writable');
    });

    it('answers failed for a ferret whose documents cannot be read', async () => {
      const w = world({ viewAnswer: 'missing' });
      const refused = await refusal(w.control.control(undefined, 's1', MODEL, 'request-1'));
      should((refused as RuntimeControlError).failure).equal('failed');
    });
  });
});

describe('what a harness that supplies only part of the switch is asked for', () => {
  const bare = (control: RuntimeControlRequest | 'models') => {
    const w = world({ switchOptions: { catalogs: 'none' } });
    return {
      w,
      call:
        control === 'models' ? w.control.models(undefined, 's1') : w.control.control(undefined, 's1', control, 'r-1'),
    };
  };

  it('answers unsupported for a model list when its live catalog cannot be projected', async () => {
    const { call } = bare('models');
    should(((await refusal(call)) as RuntimeControlError).failure).equal('unsupported');
  });

  it('answers unsupported for a targeted switch it has no switch context for, with nothing typed', async () => {
    const { w, call } = bare({ action: 'model', model: 'gpt-6', effort: 'high' });
    should(((await refusal(call)) as RuntimeControlError).failure).equal('unsupported');
    should(w.typed).eql([]);
  });

  it('answers unsupported for a fast switch it has no fast facts for', async () => {
    const { call } = bare({ action: 'fast', fast: true });
    should(((await refusal(call)) as RuntimeControlError).failure).equal('unsupported');
  });

  it('asks the harness that supplies them for the switch context and the fast facts, then types its plan', async () => {
    const w = world({
      switchOptions: { plan: { kind: 'inject', command: '/fast', requestedFast: true, claimsOutcome: true } },
    });
    await w.control.control(undefined, 's1', { action: 'model', model: 'gpt-6', effort: 'high' }, 'r-1');
    await w.control.control(undefined, 's1', { action: 'fast', fast: true }, 'r-2');
    should(w.typed).eql(['/fast', '/fast']);
  });

  it('answers unsupported for a drive of a picker it has no driver for, with nothing pressed', async () => {
    const w = world({
      switchOptions: { catalogs: 'none', plan: { kind: 'drive_picker', target: { model: 'gpt-6' } } },
    });
    const refused = await refusal(
      w.control.control(undefined, 's1', { action: 'model', model: 'gpt-6', effort: 'high' }, 'r-1'),
    );
    should((refused as RuntimeControlError).failure).equal('unsupported');
    should(w.pressed).eql([]);
  });
});

describe('the picker transport Ferrets builds over a ferret pane', () => {
  const drive = () =>
    world({ switchOptions: { plan: { kind: 'drive_picker', target: { model: 'gpt-6', effort: 'high' } }, keys: [] } });

  it('opens the picker with the harness command, reads a frame, and presses only a key of the closed set', async () => {
    const w = drive();
    const refused = await refusal(
      w.control.control(undefined, 's1', { action: 'model', model: 'gpt-6', effort: 'high' }, 'r-1'),
    );
    // The test driver presses a row's digit (allowed), then a key outside the closed set (refused), which fails the drive.
    should((refused as RuntimeControlError).failure).equal('failed');
    should(w.typed).eql(['/model']);
    should(w.pressed).eql(['2']);
  });
});

describe('a ferret pane as a harness reaches it', () => {
  const paneOf = (screen: Screen, outcome: 'handled-local' | 'turn-started' = 'handled-local') => {
    const typed: string[] = [];
    const pressed: string[] = [];
    let stopped = 0;
    const pane = ferretRuntimePane(
      seamOf(() => screen, typed, pressed, outcome),
      async () => {
        stopped += 1;
      },
    );
    return { pane, typed, pressed, stopped: () => stopped };
  };

  it('reads a pane at work as NOT at an idle prompt even when a prompt is drawn, so a control is refused, not queued', async () => {
    const frame = await paneOf({ promptReady: true, activeWork: true }).pane.observe();
    should(frame.promptReady).equal(false);
  });

  it('reads a pane parked on a dialog as not at an idle prompt', async () => {
    const frame = await paneOf({ promptReady: true, activeWork: false, blocking: 'permission' }).pane.observe();
    should(frame.promptReady).equal(false);
  });

  it('reads an idle pane as ready, with its screen', async () => {
    const frame = await paneOf(IDLE).pane.observe();
    should(frame).eql({ alive: true, dead: false, promptReady: true, visible: 'the pane' });
  });

  it('types a command through the seam and answers how the harness took it', async () => {
    const { pane, typed } = paneOf(IDLE, 'handled-local');
    should(await pane.command('/model')).equal('handled-local');
    should(typed).eql(['/model']);
    should(await paneOf(IDLE, 'turn-started').pane.command('/model')).equal('turn-started');
  });

  it('presses a navigation key and a picker row digit through their own seam members, and stops through the stop it was given', async () => {
    const { pane, pressed, stopped } = paneOf(IDLE);
    await pane.key('Tab');
    await pane.pickerKey('3');
    await pane.stop();
    should(pressed).eql(['Tab', '3']);
    should(stopped()).equal(1);
  });

  it('says so, without a sentence of its own, when the failure is no closed code at all', async () => {
    const seam = {
      deliver: async () => ({ ok: true as const, value: 'handled-local' as const }),
      form: {
        capture: async () => ({ ok: false as const, error: {} }),
        key: async () => ({ ok: false as const, error: 'nothing' }),
        pickerKey: async () => ({ ok: false as const, error: 'nothing' }),
      },
    } as unknown as FerretHarness;
    const pane = ferretRuntimePane(seam, async () => undefined);
    should(((await refusal(pane.observe())) as Error).message).match(/it could not be done/u);
    should(((await refusal(pane.key('Enter'))) as Error).message).match(/it could not be done/u);
    should(((await refusal(pane.pickerKey('3'))) as Error).message).match(/it could not be done/u);
  });

  it('says so when it could not type: a refusal reads as one sentence with its closed code, and never pane text', async () => {
    const seam = {
      deliver: async () => ({ ok: false as const, error: { refused: 'held' } }),
      form: undefined,
    } as unknown as FerretHarness;
    const pane = ferretRuntimePane(seam, async () => undefined);
    const typed = await refusal(pane.command('/model'));
    should((typed as Error).message).match(/refused: held/u);
    const read = await refusal(pane.observe());
    should((read as Error).message).match(/runner/u);
    should(((await refusal(pane.pickerKey('3'))) as Error).message).match(/runner/u);
  });

  it('has no picker key when the runner offers none: the form is there, the digit member is not', async () => {
    const seam = {
      deliver: async () => ({ ok: true as const, value: 'handled-local' as const }),
      form: {},
    } as unknown as FerretHarness;
    const pane = ferretRuntimePane(seam, async () => undefined);
    should(((await refusal(pane.pickerKey('3'))) as Error).message).match(/runner/u);
  });
});
