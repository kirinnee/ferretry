import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultStartWaitPolicy,
  parseSessionId,
  type RecordedLaunch,
  type SessionLaunchPorts,
  SessionLaunchService,
  SessionPlanner,
} from '../../../../src/lib/index.ts';
import { launchAccount, launchConfig, launchState } from './support.ts';

const WRAPPER = '/fleet/bin/claude-auto-boot';
const HARNESS_SESSION = '0f7f4a1c-1111-2222-3333-444455556666';

describe('SessionLaunchService.relaunch, when a port breaks', () => {
  it('should surface any other failure while building the argv instead of reading it as an unreadable overlay', async () => {
    // Arrange: only an overlay that cannot be read leaves a session to its record; a port that breaks
    // is a real fault, and swallowing it would restart the pane on a stale argv without saying so.
    const recorded: RecordedLaunch[] = [];
    const ports: SessionLaunchPorts = {
      planner: new SessionPlanner({
        startWait: defaultStartWaitPolicy,
        contextWindowOverrides: {},
        namePrefix: 'fyd',
        remoteControlPrefix: 'fyd',
      }),
      subject: async () => ({
        config: launchConfig({ launchFast: true }),
        state: launchState(),
        command: [WRAPPER, '--session-id', HARNESS_SESSION, '--model', 'claude-opus-5'],
      }),
      account: async () => ({ account: launchAccount(), executable: WRAPPER }),
      readableFolders: () => {
        throw new Error('the state directory is gone');
      },
      settings: async () => 'settings-now',
      fixedSettings: async () => '{"skipAutoPermissionPrompt":true}',
      transcriptStarted: async () => true,
      authorize: (_executable, argv) => argv,
      record: async (_id, launch) => {
        recorded.push(launch);
      },
    };

    // Act
    const failure = await new SessionLaunchService(ports).relaunch(parseSessionId('s1')).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(Error);
    should((failure as Error).message).equal('the state directory is gone');
    should(recorded).be.empty();
  });
});
