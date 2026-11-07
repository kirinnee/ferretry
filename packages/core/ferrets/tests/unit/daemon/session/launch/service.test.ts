import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultStartWaitPolicy,
  type LaunchSubject,
  parseSessionId,
  type RecordedLaunch,
  type SessionLaunchPorts,
  SessionLaunchService,
  SessionPlanner,
} from '../../../../src/lib/index.ts';
import { launchAccount, launchConfig, launchState } from './support.ts';

const ID = parseSessionId('s1');
const WRAPPER = '/fleet/bin/claude-auto-boot';
const HARNESS_SESSION = '0f7f4a1c-1111-2222-3333-444455556666';
const TRANSCRIPT = `/fleet/homes/boot/projects/-work-ferretry/${HARNESS_SESSION}.jsonl`;
const FOLDERS = ['/state/s1/turns', '/state/s1/channel'];
const READ_RULES = FOLDERS.map(folder => `--allowedTools=Read(/${folder}/**)`);
const LATER = '2027-01-15T09:00:00.000Z';

const planner = new SessionPlanner({
  startWait: defaultStartWaitPolicy,
  contextWindowOverrides: {},
  namePrefix: 'fyd',
  remoteControlPrefix: 'fyd',
});

/** A session started BEFORE the Read rules existed: its recorded argv has none. */
const legacySubject = (overrides: Partial<LaunchSubject> = {}): LaunchSubject => ({
  config: launchConfig({
    transcript: {
      v: 1,
      home: '/fleet/homes/boot',
      harnessSessionId: HARNESS_SESSION,
      identity: 'minted',
      file: TRANSCRIPT,
    },
  }),
  state: launchState(),
  command: [WRAPPER, '--session-id', HARNESS_SESSION, '--model', 'claude-opus-5'],
  ...overrides,
});

class Ports implements SessionLaunchPorts {
  subjectValue: LaunchSubject | undefined = legacySubject();
  accountValue: ReturnType<typeof launchAccount> | undefined = launchAccount();
  digest: string | undefined = 'settings-now';
  /** The login's fixed `--settings` text: empty is a login with none, undefined is unreadable. */
  fixed: string | undefined = '{"skipAutoPermissionPrompt":true}';
  started = true;
  readonly recorded: RecordedLaunch[] = [];
  readonly planner = planner;

  subject = async () => this.subjectValue;
  account = async () =>
    this.accountValue === undefined ? undefined : { account: this.accountValue, executable: WRAPPER };
  readableFolders = () => FOLDERS;
  settings = async () => this.digest;
  fixedSettings = async () => this.fixed;
  transcriptStarted = async (file: string) => file === TRANSCRIPT && this.started;
  authorize = (_executable: string, argv: readonly string[]) => argv;
  record = async (_id: unknown, launch: RecordedLaunch) => {
    this.recorded.push(launch);
  };
}

describe('SessionLaunchService.relaunch', () => {
  it('should rebuild a revive on current settings, record it, and resume the conversation', async () => {
    // Arrange: an old session that has since been switched to Sonnet with /model.
    const ports = new Ports();
    ports.subjectValue = legacySubject({
      state: launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER, observedReasoningEffort: 'high' }),
    });

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert: the Read rules it predates are there, on the model it is on now, resumed rather than created.
    const created = [
      WRAPPER,
      '--session-id',
      HARNESS_SESSION,
      ...READ_RULES,
      '--model',
      'claude-sonnet-5',
      '--effort',
      'high',
    ];
    should(argv).eql([
      WRAPPER,
      '--resume',
      HARNESS_SESSION,
      ...READ_RULES,
      '--model',
      'claude-sonnet-5',
      '--effort',
      'high',
    ]);
    should(ports.recorded).eql([
      { command: created, model: 'claude-sonnet-5', launchReasoningEffort: 'high', launchSettings: 'settings-now' },
    ]);
  });

  it('should still create a harness session that never wrote its transcript, and record no unknowns', async () => {
    // Arrange
    const ports = new Ports();
    ports.started = false;
    ports.digest = undefined;

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    should(argv).eql([WRAPPER, '--session-id', HARNESS_SESSION, ...READ_RULES, '--model', 'claude-opus-5']);
    should(ports.recorded).eql([{ command: argv, model: 'claude-opus-5' }]);
  });

  it('should carry the remote-control surface and the owner flags a session asked for', async () => {
    // Arrange: no transcript record, so whether it started is never asked.
    const ports = new Ports();
    ports.subjectValue = legacySubject({
      config: launchConfig({ remoteControl: true, harnessFlags: ['--verbose'] }),
      command: [WRAPPER],
    });

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    should(argv?.[0]).equal(WRAPPER);
    should(argv?.at(-1)).equal('--verbose');
    should(argv?.length).be.above(READ_RULES.length + 4);
    should(argv).not.containEql('--session-id');
    should(argv).containEql('--rc');
  });

  it('should never start the Remote Control surface for a session that did not ask for it', async () => {
    // Arrange
    const ports = new Ports();
    ports.subjectValue = legacySubject({ config: launchConfig({ remoteControl: false }), command: [WRAPPER] });

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert — the wrapper's fixed settings switch it off; --rc is the only thing that turns it on.
    should(argv).not.containEql('--rc');
    should(argv).not.containEql('--chrome');
  });

  it('should fall back to the account default when the model it was on is no longer served', async () => {
    // Arrange
    const ports = new Ports();
    ports.subjectValue = legacySubject({
      config: launchConfig({ model: 'claude-retired-4', teammate: 'Ada', parent: 'p1' }),
    });

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    should(argv).containEql('claude-opus-5');
    should(argv).not.containEql('claude-retired-4');
  });

  it('should leave a session it cannot rebuild to its record', async () => {
    // Arrange: unreadable documents, an account the fleet no longer publishes, and one re-kinded.
    const unreadable = new Ports();
    unreadable.subjectValue = undefined;
    const gone = new Ports();
    gone.accountValue = undefined;
    const rekinded = new Ports();
    rekinded.accountValue = launchAccount({ kind: 'codex' });

    // Act / Assert
    should(await new SessionLaunchService(unreadable).relaunch(ID)).be.undefined();
    should(await new SessionLaunchService(gone).relaunch(ID)).be.undefined();
    should(await new SessionLaunchService(rekinded).relaunch(ID)).be.undefined();
    should(gone.recorded).be.empty();
  });
});

describe('SessionLaunchService.relaunch, with fast mode', () => {
  it('should keep fast mode on a Claude session across a restart, carrying the fixed overlay with it', async () => {
    // Arrange: launched fast; nothing reported since.
    const ports = new Ports();
    ports.subjectValue = legacySubject({ config: launchConfig({ launchFast: true }) });

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    const overlay = '{"skipAutoPermissionPrompt":true,"fastMode":true}';
    should(argv?.slice(-2)).eql(['--settings', overlay]);
    should(ports.recorded[0]).containEql({ launchFast: true });
    should(ports.recorded[0]?.command.slice(-2)).eql(['--settings', overlay]);
  });

  it('should restart on what the harness last reported when that is newer than the launch', async () => {
    // Arrange: launched fast, then turned off with /fast off.
    const ports = new Ports();
    ports.subjectValue = legacySubject({
      config: launchConfig({ launchFast: true }),
      state: launchState({ observedFast: false, observedModelAt: LATER }),
    });

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    should(argv?.at(-1)).equal('{"skipAutoPermissionPrompt":true,"fastMode":false}');
    should(ports.recorded[0]).containEql({ launchFast: false });
  });

  it('should not turn a default into a choice: nothing decided means nothing asserted', async () => {
    // Arrange / Act
    const ports = new Ports();
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    should(argv).not.containEql('--settings');
    should(ports.recorded[0]).not.have.property('launchFast');
  });

  it('should read the overlay only for a Claude session that has a decision to carry', async () => {
    // Arrange
    let reads = 0;
    const ports = new Ports();
    ports.fixedSettings = async () => {
      reads += 1;
      return ports.fixed;
    };

    // Act
    await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    should(reads).equal(0);
  });

  it('should set a Codex service tier without reading any overlay', async () => {
    // Arrange
    const ports = new Ports();
    ports.accountValue = launchAccount({ kind: 'codex' });
    ports.subjectValue = legacySubject({
      config: launchConfig({ harness: 'codex', launchFast: true }),
      command: [WRAPPER],
    });
    ports.fixed = undefined;

    // Act
    const argv = await new SessionLaunchService(ports).relaunch(ID);

    // Assert
    should(argv?.slice(-2)).eql(['-c', 'service_tier="priority"']);
  });

  it('should leave a session to its record when its overlay cannot be read or carried', async () => {
    // Arrange
    const unreadable = new Ports();
    unreadable.fixed = undefined;
    unreadable.subjectValue = legacySubject({ config: launchConfig({ launchFast: true }) });
    const corrupt = new Ports();
    corrupt.fixed = '{not json';
    corrupt.subjectValue = legacySubject({ config: launchConfig({ launchFast: true }) });

    // Act / Assert
    should(await new SessionLaunchService(unreadable).relaunch(ID)).be.undefined();
    should(await new SessionLaunchService(corrupt).relaunch(ID)).be.undefined();
    should(unreadable.recorded).be.empty();
    should(corrupt.recorded).be.empty();
  });

  it('should surface any other failure while building the argv instead of reading it as an unreadable overlay', async () => {
    // Arrange: only an overlay that cannot be read leaves a session to its record; a port that breaks
    // is a real fault, and swallowing it would restart the pane on a stale argv without saying so.
    const ports = new Ports();
    ports.subjectValue = legacySubject({ config: launchConfig({ launchFast: true }) });
    ports.readableFolders = () => {
      throw new Error('the state directory is gone');
    };

    // Act
    const failure = await new SessionLaunchService(ports).relaunch(ID).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(Error);
    should((failure as Error).message).equal('the state directory is gone');
    should(ports.recorded).be.empty();
  });

  it('should treat the fast-mode argument as part of the run, so a live /fast is not a stale setting', async () => {
    // Arrange: the process runs with the fast overlay it launched with; the owner then typed /fast off.
    const ports = new Ports();
    ports.subjectValue = legacySubject({
      config: launchConfig({ launchFast: true }),
      state: launchState({ observedFast: false, observedModelAt: LATER }),
      command: [
        WRAPPER,
        '--session-id',
        HARNESS_SESSION,
        ...READ_RULES,
        '--model',
        'claude-opus-5',
        '--settings',
        '{"skipAutoPermissionPrompt":true,"fastMode":true}',
      ],
    });

    // Act
    const drift = await new SessionLaunchService(ports).drift(ID);

    // Assert
    should(drift).eql({ current: true, reasons: [] });
  });
});

describe('SessionLaunchService.drift', () => {
  it('should call a session stale when a relaunch would add arguments it predates', async () => {
    // Act
    const drift = await new SessionLaunchService(new Ports()).drift(ID);

    // Assert
    should(drift).eql({ current: false, reasons: ['arguments'] });
  });

  it('should call a session current when only its model, effort or resume flag differ', async () => {
    // Arrange: launched with the rules, then switched model; neither is a stale setting.
    const ports = new Ports();
    ports.subjectValue = legacySubject({
      config: launchConfig({ launchSettings: 'settings-now' }),
      state: launchState({ observedModel: 'claude-sonnet-5', observedModelAt: LATER }),
      command: [WRAPPER, '--resume', HARNESS_SESSION, ...READ_RULES, '--model', 'claude-opus-5', '--effort', 'low'],
    });

    // Act
    const drift = await new SessionLaunchService(ports).drift(ID);

    // Assert
    should(drift).eql({ current: true, reasons: [] });
  });

  it('should call a session stale when the fleet settings it launched under have changed', async () => {
    // Arrange: e.g. the permission mode or the profile changed since, which regenerated the wrapper.
    const ports = new Ports();
    ports.subjectValue = legacySubject({
      config: launchConfig({ launchSettings: 'settings-then' }),
      command: [WRAPPER, ...READ_RULES, '--model', 'claude-opus-5'],
    });

    // Act
    const drift = await new SessionLaunchService(ports).drift(ID);

    // Assert
    should(drift).eql({ current: false, reasons: ['settings'] });
  });

  it('should claim nothing it cannot show', async () => {
    // Arrange: no recorded digest, an unreadable wrapper now, an unreadable session, a gone account.
    const unrecorded = new Ports();
    unrecorded.subjectValue = legacySubject({ command: [WRAPPER, ...READ_RULES] });
    const unreadableNow = new Ports();
    unreadableNow.digest = undefined;
    unreadableNow.subjectValue = legacySubject({
      config: launchConfig({ launchSettings: 'settings-then' }),
      command: [WRAPPER, ...READ_RULES],
    });
    const missing = new Ports();
    missing.subjectValue = undefined;
    const gone = new Ports();
    gone.accountValue = undefined;

    // Act / Assert
    should(await new SessionLaunchService(unrecorded).drift(ID)).eql({ current: true, reasons: [] });
    should(await new SessionLaunchService(unreadableNow).drift(ID)).eql({ current: true, reasons: [] });
    should(await new SessionLaunchService(missing).drift(ID)).eql({ current: true, reasons: [] });
    should(await new SessionLaunchService(gone).drift(ID)).eql({ current: true, reasons: [] });
  });
});
