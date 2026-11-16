import { describe, it } from 'bun:test';
import should from 'should';
import { ApiError } from '@ferretry/kernel/contract';
import {
  type FerretHarness,
  type FerretId,
  type HarnessRuntimeSwitch,
  type RuntimeControlRequest,
  type RuntimeSwitchPane,
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
      paste: async () => ({ ok: true as const, value: undefined }),
    },
  } as unknown as FerretHarness;
}

/** A harness's switch that plans what a command-switched harness plans, and records its own use. */
function switchOf(calls: { planned: unknown[]; built: number }): (pane: RuntimeSwitchPane) => HarnessRuntimeSwitch {
  return () => {
    calls.built += 1;
    return {
      quirks: {
        planSwitch: request => {
          calls.planned.push(request);
          return { kind: 'inject', command: '/model', claimsOutcome: false };
        },
        recoverFromFailedDrive: async () => ({ kind: 'recovered' }),
        report: () => 'a report',
      },
      catalogs: {
        codexRuntimeCatalog: choices => ({ harness: 'codex', source: 'codex-app-server', choices: [...choices] }),
        codexSwitchContext: () => ({ choices: [] }),
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
    runtimeSwitchOf: () => (options.offers === false ? undefined : switchOf(state.switched)),
    view: async () => {
      state.views.reads += 1;
      return options.viewAnswer === 'missing' ? undefined : CODEX_VIEW();
    },
    journal: async (_id, event, data) => {
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

    it('refuses a ferret that is neither the target nor its lead or helper, before anything is read or typed', async () => {
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

    it('answers failed for a ferret whose documents cannot be read', async () => {
      const w = world({ viewAnswer: 'missing' });
      const refused = await refusal(w.control.control(undefined, 's1', MODEL, 'request-1'));
      should((refused as RuntimeControlError).failure).equal('failed');
    });
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

  it('presses a key through the form seam and stops through the stop it was given', async () => {
    const { pane, pressed, stopped } = paneOf(IDLE);
    await pane.key('3');
    await pane.stop();
    should(pressed).eql(['3']);
    should(stopped()).equal(1);
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
  });
});
