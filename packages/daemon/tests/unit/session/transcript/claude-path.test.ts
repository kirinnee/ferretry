import { describe, it } from 'bun:test';
import should from 'should';
import {
  claudeProjectDirectory,
  claudeSessionArguments,
  claudeTranscriptFile,
} from '../../../../src/lib/session/transcript/index.ts';

const SESSION = '0f7f4a1c-1111-2222-3333-444455556666';

describe('claude transcript paths', () => {
  it("should encode a working directory the way the harness's own project directory does", () => {
    // Arrange / Act
    const directory = claudeProjectDirectory('/home/agent/Workspace/personal/ferretry-wt-provenance');

    // Assert
    should(directory).equal('-home-agent-Workspace-personal-ferretry-wt-provenance');
  });

  it('should replace every non-alphanumeric character, including dots and underscores', () => {
    // Arrange / Act
    const directory = claudeProjectDirectory('/srv/repo.v2/my_app');

    // Assert
    should(directory).equal('-srv-repo-v2-my-app');
  });

  it('should name the exact file the harness will write for a minted session id', () => {
    // Arrange / Act
    const file = claudeTranscriptFile('/home/agent/.claude', '/work/repo', SESSION);

    // Assert
    should(file).equal(`/home/agent/.claude/projects/-work-repo/${SESSION}.jsonl`);
  });

  it('should distinguish two sessions in one directory by filename alone', () => {
    // Arrange: this is the property the whole minted path rests on — a shared cwd is not ambiguity.
    const first = claudeTranscriptFile('/home/agent/.claude', '/work/repo', 'aaa');
    const second = claudeTranscriptFile('/home/agent/.claude', '/work/repo', 'bbb');

    // Act / Assert
    should(first).not.equal(second);
  });

  it('should pass the minted id to the harness so the named file is the one it writes', () => {
    // Arrange / Act
    const args = claudeSessionArguments(SESSION);

    // Assert
    should(args).eql(['--session-id', SESSION]);
  });
});
