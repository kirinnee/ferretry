import { describe, expect, it } from 'bun:test';
import { claudeRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';
import { CLAUDE_NO_QUESTIONS_FLAG } from '../../daemon/lib/harness/launch.ts';

const wrapper = () => {
  const kit = claudeRuntimesKit.wrapper;
  if (kit === undefined) throw new Error('Claude gives no launch line');
  return kit;
};

describe('Claude kit launch line', () => {
  it('should name the arguments that may resume a conversation', () => {
    expect(wrapper().conversationArgs).toBe('--resume|--resume=*|-r|--session-id|--session-id=*');
  });

  it('should start a model with --model', () => {
    expect(wrapper().modelArgs('golden-model')).toEqual(['--model', 'golden-model']);
  });

  it('should carry a section as written', () => {
    expect(wrapper().quoteSection('a "b" \\ c')).toBe('a "b" \\ c');
  });

  it('should take the sections after the appended system prompt and no other argument', () => {
    expect(wrapper().instructionArgument('--append-system-prompt=words')).toEqual({
      before: '--append-system-prompt=words',
      after: '',
    });
    expect(wrapper().instructionArgument('--append-system-prompt')).toBeUndefined();
    expect(wrapper().instructionArgument('developer_instructions="words"')).toBeUndefined();
  });

  it('should withhold the question tool, and say the exec line need not repeat the flag', () => {
    expect(wrapper().questionLines()).toEqual([`set -- ${CLAUDE_NO_QUESTIONS_FLAG} "$@"`]);
    expect(wrapper().suppliedArguments).toEqual([CLAUDE_NO_QUESTIONS_FLAG]);
  });

  it('should seed the first run inside the home variable it is given', () => {
    const lines = wrapper().autonomousPrelude?.({ homeEnv: 'SOME_HOME' }) ?? [];
    const text = lines.join('\n');
    expect(text).toContain('_fy_seed_cfg="$SOME_HOME/.claude.json"');
    expect(text).toContain('FY_SEED_FIRST_RUN');
    expect(text).toContain('hasTrustDialogAccepted');
    expect(text).toContain('fullscreenUpsellSeenCount');
  });

  it('should probe the installed command for the snapshot flag', () => {
    const text = (wrapper().promptSnapshotLines?.('/opt/bin/claude') ?? []).join('\n');
    expect(text).toContain('/opt/bin/claude --help');
    expect(text).toContain('set -- --system-prompt-snapshot=off "$@"');
  });
});
