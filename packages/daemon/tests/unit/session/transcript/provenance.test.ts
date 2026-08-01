import { describe, it } from 'bun:test';
import should from 'should';
import {
  TranscriptProvenanceCapture,
  type CodexRolloutBaseline,
  type HarnessSessionIdFactory,
  type HarnessWrapperSource,
  type TranscriptCaptureRequest,
} from '../../../../src/lib/session/transcript/index.ts';

const AT = '2026-08-01T09:00:00.000Z';
const MINTED = '9d1f0a2b-1111-2222-3333-444455556666';
const ENVIRONMENT = { HOME: '/home/agent' };

const wrappers = (scripts: Readonly<Record<string, string>>): HarnessWrapperSource => ({
  read: async executable => scripts[executable],
});

const ids = (value = MINTED): HarnessSessionIdFactory => ({ next: () => value });

const baselines = (rollouts: readonly string[] = []): CodexRolloutBaseline => ({ ids: async () => rollouts });

const request = (overrides: Partial<TranscriptCaptureRequest> = {}): TranscriptCaptureRequest => ({
  harness: 'claude',
  executable: '/fleet/bin/claude-auto-loge',
  cwd: '/work/repo',
  correlationToken: '/state/sessions/session-1',
  at: AT,
  ...overrides,
});

const CLAUDE_WRAPPER = 'export CLAUDE_CONFIG_DIR="$HOME/.claude-loge"\nexec claude "$@"\n';
const CODEX_WRAPPER = 'export CODEX_HOME="$HOME/.codex-terra"\nexec codex "$@"\n';

describe('TranscriptProvenanceCapture', () => {
  it('should mint a claude session id, name its file, and put the id on the launch argv', async () => {
    // Arrange
    const subject = new TranscriptProvenanceCapture(
      wrappers({ '/fleet/bin/claude-auto-loge': CLAUDE_WRAPPER }),
      ids(),
      baselines(),
      ENVIRONMENT,
    );

    // Act
    const captured = await subject.capture(request());

    // Assert
    should(captured.provenance).eql({
      v: 1,
      home: '/home/agent/.claude-loge',
      harnessSessionId: MINTED,
      identity: 'minted',
      file: `/home/agent/.claude-loge/projects/-work-repo/${MINTED}.jsonl`,
      resolvedAt: AT,
    });
    should(captured.launchArguments).eql(['--session-id', MINTED]);
  });

  it('should record the codex baseline and the correlation token without claiming a file', async () => {
    // Arrange: everything already under the home belongs to somebody else.
    const subject = new TranscriptProvenanceCapture(
      wrappers({ '/fleet/bin/codex-auto-terra': CODEX_WRAPPER }),
      ids(),
      baselines(['rollout-a', 'rollout-b']),
      ENVIRONMENT,
    );

    // Act
    const captured = await subject.capture(request({ harness: 'codex', executable: '/fleet/bin/codex-auto-terra' }));

    // Assert
    should(captured.provenance).eql({
      v: 1,
      home: '/home/agent/.codex-terra',
      identity: 'undiscovered',
      baseline: ['rollout-a', 'rollout-b'],
      correlationToken: '/state/sessions/session-1',
    });
    should(captured.launchArguments).eql([]);
  });

  it('should capture nothing when the wrapper cannot be read', async () => {
    // Arrange: a host whose fleet executable is a binary, or a path the daemon cannot open.
    const subject = new TranscriptProvenanceCapture(wrappers({}), ids(), baselines(), ENVIRONMENT);

    // Act
    const captured = await subject.capture(request());

    // Assert
    should(captured.provenance).be.undefined();
    should(captured.launchArguments).eql([]);
  });

  it('should capture nothing when the wrapper declares no resolvable harness home', async () => {
    // Arrange: a guessed home would name a transcript that never appears.
    const subject = new TranscriptProvenanceCapture(
      wrappers({ '/fleet/bin/claude-auto-loge': 'export CLAUDE_CONFIG_DIR=$UNSET_ROOT/.claude\n' }),
      ids(),
      baselines(),
      ENVIRONMENT,
    );

    // Act
    const captured = await subject.capture(request());

    // Assert
    should(captured.provenance).be.undefined();
  });

  it('should give two claude sessions in one directory different transcripts', async () => {
    // Arrange: the identity comes from the minted id, never from the directory they share.
    const queue = ['first-id', 'second-id'];
    const subject = new TranscriptProvenanceCapture(
      wrappers({ '/fleet/bin/claude-auto-loge': CLAUDE_WRAPPER }),
      { next: () => queue.shift() ?? 'exhausted' },
      baselines(),
      ENVIRONMENT,
    );

    // Act
    const first = await subject.capture(request());
    const second = await subject.capture(request());

    // Assert
    should(first.provenance?.file).not.equal(second.provenance?.file);
  });
});
