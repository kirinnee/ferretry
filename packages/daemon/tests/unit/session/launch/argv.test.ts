import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildLaunchArgv,
  effortLaunchArguments,
  settingsArguments,
  transcriptLaunchArguments,
} from '../../../../src/lib/session/launch/index.ts';

const WRAPPER = '/fleet/bin/claude-auto-boot';
const HARNESS_SESSION = '0f7f4a1c-1111-2222-3333-444455556666';

describe('buildLaunchArgv', () => {
  it('should put every daemon-owned part on the argv in launch order, the owner flags last', () => {
    // Arrange: an owner flag naming its own model must still win, so it has to come after ours.
    const parts = {
      harness: 'claude' as const,
      executable: WRAPPER,
      remoteControl: ['--remote-control', 'fyd-s1'],
      transcript: ['--session-id', HARNESS_SESSION],
      readableFolders: ['/state/s1/turns'],
      model: 'claude-sonnet-5',
      effort: 'high',
      harnessFlags: ['--model', 'claude-opus-5'],
    };

    // Act
    const argv = buildLaunchArgv(parts);

    // Assert
    should(argv).eql([
      WRAPPER,
      '--remote-control',
      'fyd-s1',
      '--session-id',
      HARNESS_SESSION,
      '--allowedTools=Read(//state/s1/turns/**)',
      '--model',
      'claude-sonnet-5',
      '--effort',
      'high',
      '--model',
      'claude-opus-5',
    ]);
  });

  it('should leave the model and effort to the wrapper and the harness when none is named', () => {
    // Arrange: Codex takes no Read rules, because its sandbox already reads anywhere.
    const parts = {
      harness: 'codex' as const,
      executable: '/fleet/bin/codex-auto-boot',
      remoteControl: [],
      transcript: [],
      readableFolders: ['/state/s1/turns'],
      harnessFlags: [],
    };

    // Act
    const argv = buildLaunchArgv(parts);

    // Assert
    should(argv).eql(['/fleet/bin/codex-auto-boot']);
  });
});

describe('effortLaunchArguments', () => {
  it('should spell the effort in each harness own way, and not at all when there is none', () => {
    // Act / Assert: Codex has no flag, so its config key is overridden for one invocation.
    should(effortLaunchArguments('claude', 'max')).eql(['--effort', 'max']);
    should(effortLaunchArguments('codex', 'x"h\\')).eql(['-c', 'model_reasoning_effort="x\\"h\\\\"']);
    should(effortLaunchArguments('claude', undefined)).eql([]);
  });
});

describe('transcriptLaunchArguments', () => {
  it('should name the harness session the start minted', () => {
    // Arrange
    const provenance = {
      v: 1 as const,
      home: '/fleet/homes/boot',
      harnessSessionId: HARNESS_SESSION,
      identity: 'minted' as const,
      file: `/fleet/homes/boot/projects/-work/${HARNESS_SESSION}.jsonl`,
    };

    // Act
    const argv = transcriptLaunchArguments('claude', provenance, [WRAPPER]);

    // Assert
    should(argv).eql(['--session-id', HARNESS_SESSION]);
  });

  it('should keep the id a session recorded before provenance existed, in either spelling', () => {
    // Arrange: creating a new conversation here would lose the one being revived.
    const created = [WRAPPER, '--session-id', HARNESS_SESSION];
    const resumed = [WRAPPER, '--resume', HARNESS_SESSION];

    // Act / Assert
    should(transcriptLaunchArguments('claude', undefined, created)).eql(['--session-id', HARNESS_SESSION]);
    should(transcriptLaunchArguments('claude', undefined, resumed)).eql(['--session-id', HARNESS_SESSION]);
  });

  it('should carry nothing for a session that never named one, a dangling flag, or Codex', () => {
    // Act / Assert
    should(transcriptLaunchArguments('claude', undefined, [WRAPPER, '--model', 'x'])).eql([]);
    should(transcriptLaunchArguments('claude', undefined, [WRAPPER, '--session-id'])).eql([]);
    should(transcriptLaunchArguments('codex', undefined, [WRAPPER, '--session-id', HARNESS_SESSION])).eql([]);
  });
});

describe('transcriptLaunchArguments, for a Codex conversation Ferretry adopted', () => {
  it('should keep resuming the conversation it was adopted on', () => {
    // Arrange: an adopted conversation started as `codex resume <id>`; a revive must not start afresh.
    const provenance = {
      v: 1 as const,
      home: '/fleet/homes/codex',
      harnessSessionId: HARNESS_SESSION,
      identity: 'adopted' as const,
      file: `/fleet/homes/codex/sessions/rollout-${HARNESS_SESSION}.jsonl`,
    };
    const recorded = ['/fleet/bin/codex-auto', 'resume', HARNESS_SESSION];

    // Act / Assert: from the record of adoption, or from the argv a document without one kept.
    should(transcriptLaunchArguments('codex', provenance, ['/fleet/bin/codex-auto'])).eql(['resume', HARNESS_SESSION]);
    should(transcriptLaunchArguments('codex', undefined, recorded)).eql(['resume', HARNESS_SESSION]);
    should(transcriptLaunchArguments('codex', undefined, ['/fleet/bin/codex-auto', 'resume'])).eql([]);
  });
});

describe('settingsArguments', () => {
  it('should drop what describes the run and keep what describes the settings', () => {
    // Arrange: a model switched with /model, or a revive's resume flag, is not a stale setting.
    const argv = [
      WRAPPER,
      '--resume',
      HARNESS_SESSION,
      '--allowedTools=Read(//state/s1/turns/**)',
      '--model',
      'claude-opus-5',
      '--effort',
      'high',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'model="gpt-5"',
      '-c',
      'sandbox_mode="danger"',
      '--verbose',
    ];

    // Act
    const kept = settingsArguments(argv);

    // Assert
    should(kept).eql([WRAPPER, '--allowedTools=Read(//state/s1/turns/**)', '-c', 'sandbox_mode="danger"', '--verbose']);
  });

  it('should keep a trailing -c that carries no value', () => {
    // Act / Assert
    should(settingsArguments([WRAPPER, '-c'])).eql([WRAPPER, '-c']);
  });
});
