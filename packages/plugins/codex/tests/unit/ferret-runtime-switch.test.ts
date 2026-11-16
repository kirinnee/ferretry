import { describe, it } from 'bun:test';
import should from 'should';
import type { FormKey, PickerKey, RuntimeSwitchFrame, RuntimeSwitchPane } from '@ferretry/core-ferrets/contract';
import { codexRuntimeSwitch, VerifiedPickerTransport } from '../../daemon/lib/ferret-runtime-switch.ts';
import type { CodexPickerDrivePort } from '../../daemon/lib/picker-drive.ts';

/**
 * Codex's part of the live switch, with the ferret's pane replaced by a script of screens. The screens are real
 * picker text run through the real classifier, because the digit this sends is derived from that text and nothing else.
 */

const QUICK = ['Select Model', '  1. gpt-5.6-codex', '  2. gpt-5.6-terra', '  3. All models'].join('\n');
const IDLE = '› Ask Codex to do anything';

/** A pane that answers the screens it was given in order (the last one stays), and records what it was told. */
class ScriptedPane implements RuntimeSwitchPane {
  readonly typed: string[] = [];
  readonly pressed: (FormKey | PickerKey)[] = [];
  stops = 0;
  #observations = 0;

  constructor(
    private readonly screens: readonly (Partial<RuntimeSwitchFrame> & { readonly visible: string })[],
    private readonly outcome: 'handled-local' | 'turn-started' = 'handled-local',
  ) {}

  async observe(): Promise<RuntimeSwitchFrame> {
    const screen = this.screens[Math.min(this.#observations, this.screens.length - 1)];
    this.#observations += 1;
    return { alive: true, dead: false, promptReady: false, ...screen, visible: screen?.visible ?? '' };
  }

  async command(text: string) {
    this.typed.push(text);
    return this.outcome;
  }

  async key(key: FormKey): Promise<void> {
    this.pressed.push(key);
  }

  async pickerKey(key: PickerKey): Promise<void> {
    this.pressed.push(key);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

const NO_WAIT = { sleep: async () => undefined };
const choices = { get: async () => [] };
const build = (pane: RuntimeSwitchPane) => codexRuntimeSwitch({ choices, sleeper: NO_WAIT, binaryName: 'fy' })(pane);

/** The pane's own part of a picker transport, as Ferrets builds it: open with the command, read a frame, press a key. */
const transportOver = (pane: ScriptedPane): CodexPickerDrivePort => ({
  openPicker: async () => await pane.command('/model'),
  readPane: async () => await pane.observe(),
  sendKey: async key => await pane.pickerKey(key as PickerKey),
});

const quickRow = { number: 1, name: 'gpt-5.6-codex' };
const expectation = { kind: 'quick-models', title: 'Select Model', row: quickRow } as const;

describe('Codex runtime switch, over a ferret pane', () => {
  it('hands the held catalog back as the live catalog', async () => {
    const held = { get: async () => [{ value: 'gpt-6', label: 'GPT 6', reasoningEfforts: [] }] };
    const subject = codexRuntimeSwitch({ choices: held, sleeper: NO_WAIT, binaryName: 'fy' })(new ScriptedPane([]));
    should((await subject.liveCatalog?.get('/bin/codex', '/work'))?.map(choice => choice.value)).eql(['gpt-6']);
  });

  it('plans a targeted Codex switch as a picker drive and refuses an effort alone, as Codex does', () => {
    const { quirks } = build(new ScriptedPane([]));
    const context = {
      wrapper: 'codex-auto',
      catalog: { choices: [{ value: 'gpt-6', reasoningEfforts: [{ value: 'high' }] }] },
    };
    should(quirks.planSwitch({ harness: 'codex', model: 'gpt-6', effort: 'high' }, context).kind).equal('drive_picker');
    should(quirks.planSwitch({ harness: 'codex', effort: 'high' }, context).kind).equal('refused');
    should(quirks.planSwitch({ harness: 'codex' }, context)).eql({
      kind: 'inject',
      command: '/model',
      claimsOutcome: false,
    });
  });

  describe('the picker transport', () => {
    const driverFor = (pane: ScriptedPane) => (sleeper: typeof NO_WAIT) =>
      build(pane).catalogs.pickerDriver?.(transportOver(pane), sleeper);

    it('presses the digit of a row it has just proved is still on screen, through the form seam', async () => {
      const pane = new ScriptedPane([
        { visible: IDLE, promptReady: true },
        { visible: QUICK },
        { visible: QUICK },
        { visible: QUICK },
        { visible: IDLE, promptReady: true },
      ]);
      const driver = driverFor(pane)?.(NO_WAIT);
      await driver?.drive({ model: 'gpt-5.6-codex' });
      should(pane.typed).eql(['/model']);
      should(pane.pressed).eql(['1']);
    });

    it('refuses to open a picker Codex read as a message: a model turn it started is reported, not hidden', async () => {
      const pane = new ScriptedPane([{ visible: QUICK }], 'turn-started');
      let failure: unknown;
      await driverFor(pane)(NO_WAIT)
        ?.drive({ model: 'gpt-5.6-codex' })
        .catch((error: unknown) => {
          failure = error;
        });
      should(String(failure)).match(/consumed the picker command as a model turn/u);
      should(pane.pressed).eql([]);
    });

    it('sends no key when the row it was told to press is no longer on screen', async () => {
      // The transport is the one the driver builds; reaching it directly proves the verification is its own.
      const pane = new ScriptedPane([{ visible: IDLE, promptReady: true }]);
      const picker = driverFor(pane);
      should(picker).be.ok();
      const stale = new VerifiedPickerTransport(transportOver(pane));
      let failure: unknown;
      await stale.sendKey('1', expectation).catch((error: unknown) => {
        failure = error;
      });
      should(String(failure)).match(/picker changed before/u);
      should(pane.pressed).eql([]);
    });

    it('refuses a key that is not a row digit and a digit that is not the verified row', async () => {
      const pane = new ScriptedPane([{ visible: QUICK }]);
      const transport = new VerifiedPickerTransport(transportOver(pane));
      for (const [key, why] of [
        ['Enter', /refusing to send/u],
        ['2', /no longer matches the verified row/u],
      ] as const) {
        let failure: unknown;
        await transport.sendKey(key, expectation).catch((error: unknown) => {
          failure = error;
        });
        should(String(failure)).match(why);
      }
      should(pane.pressed).eql([]);
    });
  });

  describe('recovering from a failed drive', () => {
    it('settles when the picker closes under Escape, and says the session is fine', async () => {
      const pane = new ScriptedPane([{ visible: QUICK }, { visible: IDLE, promptReady: true }]);
      const recovery = await build(pane).quirks.recoverFromFailedDrive('ignored', new Error('boom'));
      should(recovery.kind).equal('recovered');
      should(pane.pressed).eql(['Escape']);
    });

    it('quarantines when cleanup cannot confirm the pane returned to an idle prompt', async () => {
      const pane = new ScriptedPane([{ visible: QUICK }]);
      const recovery = await build(pane).quirks.recoverFromFailedDrive('ignored', new Error('boom'));
      should(recovery.kind).equal('quarantine');
      if (recovery.kind === 'quarantine') {
        should(recovery.quarantine.needsHumanKind).equal('codex_picker_cleanup');
        should(recovery.quarantine.needsHuman).match(/`fy resume`/u);
        should(recovery.quarantine.evidence.driveError).equal('boom');
      }
    });
  });

  describe('fast mode facts', () => {
    it('reads the model and fast mode in force from the two documents, flattened for the planner', () => {
      const facts = build(new ScriptedPane([])).catalogs.fastModeFacts;
      const view = {
        config: { model: 'gpt-6', launchFast: false },
        state: { observedModel: 'gpt-6', observedFast: true },
      } as never;
      const catalog = {
        harness: 'codex',
        source: 'codex-app-server',
        choices: [{ value: 'gpt-6', label: 'GPT 6', reasoningEfforts: [], fast: true }],
      } as never;
      should(facts?.(view, catalog)).eql({ supported: true, model: 'GPT 6', current: true });
    });
  });
});
