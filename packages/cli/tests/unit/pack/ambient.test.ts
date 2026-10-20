import { describe, it } from 'bun:test';
import should from 'should';
import { ambientSession, tmuxEnvironmentValue } from '../../../src/lib/pack/ambient.ts';

describe('tmuxEnvironmentValue', () => {
  it.each([
    ['FY_SESSION_ID=ses-1\n', 'ses-1'],
    ['OTHER=1\nFY_SESSION_ID= ses-2 \r\n', 'ses-2'],
    ['-FY_SESSION_ID\n', undefined],
    ['FY_SESSION_ID=\n', undefined],
    ['FY_SESSION_ID_OTHER=x\n', undefined],
    ['', undefined],
  ] as const)('should read %j as %j', (output, expected) => {
    should(tmuxEnvironmentValue(output, 'FY_SESSION_ID')).equal(expected);
  });
});

describe('ambientSession', () => {
  it("should take the pane's own FY_SESSION_ID first, without asking tmux", async () => {
    // Arrange
    const asked: string[][] = [];

    // Act
    const actual = await ambientSession({ FY_SESSION_ID: ' ses-own ', TMUX: '/s,1,0' }, async argv => {
      asked.push([...argv]);
      return 'FY_SESSION_ID=ses-tmux\n';
    });

    // Assert
    should(actual).equal('ses-own');
    should(asked).deepEqual([]);
  });

  it('should ask the tmux session for its copy when a subshell dropped the variable', async () => {
    // Arrange
    const asked: string[][] = [];

    // Act
    const actual = await ambientSession({ FY_SESSION_ID: '', TMUX: '/s,1,0' }, async argv => {
      asked.push([...argv]);
      return 'FY_SESSION_ID=ses-tmux\n';
    });

    // Assert
    should(actual).equal('ses-tmux');
    should(asked).deepEqual([['tmux', 'show-environment', 'FY_SESSION_ID']]);
  });

  it('should be no session outside tmux, and when tmux cannot answer', async () => {
    // Act + Assert
    should(await ambientSession({}, async () => 'FY_SESSION_ID=x\n')).be.undefined();
    should(await ambientSession({ TMUX: '/s,1,0' }, async () => undefined)).be.undefined();
  });
});
