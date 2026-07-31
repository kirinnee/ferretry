import { describe, it } from 'bun:test';
import should from 'should';
import {
  CODEX_PICKER_QUARANTINE_KIND,
  CodexPickerCleanup,
  defaultPickerCleanupPolicy,
  failureMessage,
  HarnessQuirkService,
  isPickerQuarantined,
  pickerFailureReport,
  pickerInputRefusal,
  quarantineUnconfirmedPicker,
  type CodexPickerPanePort,
  type PickerPaneObservation,
} from '../../../../src/lib/session/harness/index.ts';

const PICKER = ['Select Model', '  1. gpt-5-codex'].join('\n');
const IDLE = '$ \n';

/** A pane that yields the queued observations in order, recording every key sent. */
class ScriptedPane implements CodexPickerPanePort {
  readonly escapes: string[] = [];
  readonly sleeps: number[] = [];
  private index = 0;

  constructor(
    private readonly observations: readonly PickerPaneObservation[],
    private readonly paneId: string = '%4',
    private readonly failures: {
      readonly resolve?: Error;
      readonly observe?: Error;
      readonly escape?: Error;
    } = {},
  ) {}

  async resolvePaneId(): Promise<string> {
    if (this.failures.resolve !== undefined) throw this.failures.resolve;
    return this.paneId;
  }

  async observe(): Promise<PickerPaneObservation> {
    if (this.failures.observe !== undefined) throw this.failures.observe;
    const observation = this.observations[Math.min(this.index, this.observations.length - 1)];
    this.index += 1;
    if (observation === undefined) throw new Error('the test queued no observation');
    return observation;
  }

  async sendEscape(paneId: string): Promise<void> {
    if (this.failures.escape !== undefined) throw this.failures.escape;
    this.escapes.push(paneId);
  }
}

const cleanupOver = (
  pane: ScriptedPane,
  policy = defaultPickerCleanupPolicy,
): { readonly cleanup: CodexPickerCleanup; readonly sleeps: number[] } => {
  const sleeps: number[] = [];
  return {
    cleanup: new CodexPickerCleanup(
      pane,
      {
        sleep: async milliseconds => {
          sleeps.push(milliseconds);
        },
      },
      policy,
    ),
    sleeps,
  };
};

describe('CodexPickerCleanup', () => {
  it('should settle without sending a key when the pane is already idle', async () => {
    // Arrange
    const pane = new ScriptedPane([{ visiblePane: IDLE, promptReady: true }]);
    const { cleanup } = cleanupOver(pane);

    // Act
    const outcome = await cleanup.dismiss('fy-abc');

    // Assert
    should(outcome).eql({ kind: 'settled' });
    should(pane.escapes).eql([]);
  });

  it('should escape the exact resolved pane until the picker closes', async () => {
    // Arrange
    const pane = new ScriptedPane(
      [
        { visiblePane: PICKER, promptReady: false },
        { visiblePane: PICKER, promptReady: false },
        { visiblePane: IDLE, promptReady: true },
      ],
      '%9',
    );
    const { cleanup, sleeps } = cleanupOver(pane);

    // Act
    const outcome = await cleanup.dismiss('fy-abc');

    // Assert: every key went to the pane resolved once at the start.
    should(outcome).eql({ kind: 'settled' });
    should(pane.escapes).eql(['%9', '%9']);
    should(sleeps).eql([defaultPickerCleanupPolicy.settleMs, defaultPickerCleanupPolicy.settleMs]);
  });

  it('should stop after the attempt budget rather than after a duration', async () => {
    // Arrange: the picker never closes. Nothing here reads a clock, so a slow host
    // cannot change the result.
    const pane = new ScriptedPane([{ visiblePane: PICKER, promptReady: false }]);
    const { cleanup } = cleanupOver(pane, { settleMs: 0, maxAttempts: 3 });

    // Act
    const outcome = await cleanup.dismiss('fy-abc');

    // Assert
    should(outcome).eql({ kind: 'unconfirmed', reason: 'Select Model was still open after 3 dismiss attempts' });
    should(pane.escapes.length).eql(3);
  });

  it('should refuse a pane id tmux would not let it address', async () => {
    // Arrange
    const pane = new ScriptedPane([{ visiblePane: IDLE, promptReady: true }], 'not-a-pane');
    const { cleanup } = cleanupOver(pane);

    // Act
    const outcome = await cleanup.dismiss('fy-abc');

    // Assert
    should(outcome).eql({
      kind: 'unconfirmed',
      reason: 'tmux returned "not-a-pane", which is not a pane cleanup can address',
    });
    should(pane.escapes).eql([]);
  });

  it.each([
    { name: 'resolving the pane', failures: { resolve: new Error('no server running') } },
    { name: 'capturing the pane', failures: { observe: new Error('pane not found') } },
    { name: 'sending the key', failures: { escape: new Error('send-keys failed') } },
  ])('should report unconfirmed when tmux fails while $name', async ({ failures }) => {
    // Arrange
    const pane = new ScriptedPane([{ visiblePane: PICKER, promptReady: false }], '%4', failures);
    const { cleanup } = cleanupOver(pane, { settleMs: 0, maxAttempts: 2 });

    // Act
    const outcome = await cleanup.dismiss('fy-abc');

    // Assert: an inspection that could not run is no proof of an idle prompt.
    should(outcome.kind).eql('unconfirmed');
    should(outcome.kind === 'unconfirmed' && outcome.reason).match(/^the pane could not be inspected: /);
  });
});

describe('picker quarantine', () => {
  it('should record BOTH failures and name the CLI a human types', () => {
    // Arrange / Act
    const quarantine = quarantineUnconfirmedPicker('fy', new Error('digit went nowhere'), 'escape ignored');

    // Assert
    should(quarantine.needsHumanKind).eql(CODEX_PICKER_QUARANTINE_KIND);
    should(quarantine.evidence).eql({ driveError: 'digit went nowhere', cleanupError: 'escape ignored' });
    should(quarantine.needsHuman).match(/`fy resume`.*`fy stop`/);
  });

  it('should recognise its own durable marker and nothing else', () => {
    // Arrange / Act / Assert
    should(isPickerQuarantined({ needsHumanKind: CODEX_PICKER_QUARANTINE_KIND })).eql(true);
    should(isPickerQuarantined({ needsHumanKind: 'tmux_kill_failed' })).eql(false);
    should(isPickerQuarantined({})).eql(false);
  });

  it('should refuse input with an instruction naming the binary', () => {
    // Arrange / Act
    const refusal = pickerInputRefusal('fy');

    // Assert
    should(refusal).match(/`fy resume <session>`/);
    should(refusal).match(/`fy stop <session>`/);
  });

  it.each([
    { name: 'an Error', failure: new Error('boom'), expected: 'boom' },
    { name: 'a thrown string', failure: 'plain failure', expected: 'plain failure' },
    { name: 'a thrown object', failure: { code: 7 }, expected: '[object Object]' },
  ])('should render $name as a message', ({ failure, expected }) => {
    // Arrange / Act / Assert
    should(failureMessage(failure)).eql(expected);
  });

  it('should tell the caller the pane was stopped when stopping succeeded', () => {
    // Arrange
    const quarantine = quarantineUnconfirmedPicker('fy', new Error('drive failed'), new Error('cleanup failed'));

    // Act
    const report = pickerFailureReport(quarantine, undefined);

    // Assert
    should(report).eql(
      'Codex picker drive failed: drive failed; picker cleanup failed: cleanup failed; ' +
        'session was stopped for safety and must be resumed before retrying runtime control',
    );
  });

  it('should say a live pane is still holding the modal when stopping also failed', () => {
    // Arrange
    const quarantine = quarantineUnconfirmedPicker('fy', new Error('drive failed'), new Error('cleanup failed'));

    // Act
    const report = pickerFailureReport(quarantine, new Error('kill-session refused'));

    // Assert
    should(report).match(/its tmux pane could not be stopped: kill-session refused$/);
  });
});

describe('HarnessQuirkService', () => {
  const serviceOver = (pane: ScriptedPane): HarnessQuirkService =>
    new HarnessQuirkService(cleanupOver(pane, { settleMs: 0, maxAttempts: 2 }).cleanup, 'fy');

  it('should report recovery when cleanup confirms an idle prompt', async () => {
    // Arrange
    const service = serviceOver(new ScriptedPane([{ visiblePane: IDLE, promptReady: true }]));

    // Act
    const recovery = await service.recoverFromFailedDrive('fy-abc', new Error('drive failed'));

    // Assert
    should(recovery).eql({ kind: 'recovered' });
  });

  it('should demand a quarantine carrying both failures when cleanup is unconfirmed', async () => {
    // Arrange
    const service = serviceOver(new ScriptedPane([{ visiblePane: PICKER, promptReady: false }]));

    // Act
    const recovery = await service.recoverFromFailedDrive('fy-abc', new Error('digit went nowhere'));

    // Assert
    should(recovery.kind).eql('quarantine');
    should(recovery.kind === 'quarantine' && recovery.quarantine.evidence).eql({
      driveError: 'digit went nowhere',
      cleanupError: 'Select Model was still open after 2 dismiss attempts',
    });
  });

  it('should plan a switch through the same quirk table', () => {
    // Arrange
    const service = serviceOver(new ScriptedPane([{ visiblePane: IDLE, promptReady: true }]));

    // Act
    const plan = service.planSwitch({ harness: 'codex' }, { wrapper: 'codex-auto-sol' });

    // Assert
    should(plan).eql({ kind: 'inject', command: '/model', claimsOutcome: false });
  });

  it('should render the caller-facing report for a quarantine', () => {
    // Arrange
    const service = serviceOver(new ScriptedPane([{ visiblePane: IDLE, promptReady: true }]));
    const quarantine = quarantineUnconfirmedPicker('fy', new Error('drive'), new Error('cleanup'));

    // Act / Assert
    should(service.report(quarantine)).match(/session was stopped for safety/);
  });
});
