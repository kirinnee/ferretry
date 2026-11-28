import { describe, expect, it } from 'bun:test';
import { codexRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';

const wrapper = () => {
  const kit = codexRuntimesKit.wrapper;
  if (kit === undefined) throw new Error('Codex gives no launch line');
  return kit;
};

describe('Codex kit launch line', () => {
  it('should name resume as the argument that may resume a conversation', () => {
    expect(wrapper().conversationArgs).toBe('resume');
  });

  it('should start a model with a -c override, escaping only a backslash and a quote', () => {
    expect(wrapper().modelArgs('golden-model')).toEqual(['-c', 'model="golden-model"']);
    expect(wrapper().modelArgs('a"b\\c')).toEqual(['-c', 'model="a\\"b\\\\c"']);
  });

  it('should carry a section already escaped for a TOML string, every control character as \\u escapes', () => {
    expect(wrapper().quoteSection('a "b" \\ c\n\td')).toBe('a \\"b\\" \\\\ c\\u000a\\u0009d');
  });

  it('should take the sections inside the closing quote of developer_instructions and no other argument', () => {
    expect(wrapper().instructionArgument('developer_instructions="words"')).toEqual({
      before: 'developer_instructions="words',
      after: '"',
    });
    expect(wrapper().instructionArgument('developer_instructions="words')).toBeUndefined();
    expect(wrapper().instructionArgument('--append-system-prompt=words')).toBeUndefined();
  });

  it('should switch the question tool explicitly off', () => {
    expect(wrapper().questionLines()).toEqual(['set -- -c features.default_mode_request_user_input=false "$@"']);
  });

  it('should supply no argument of its own and give no first-run seed or snapshot probe', () => {
    expect(wrapper().suppliedArguments).toBeUndefined();
    expect(wrapper().autonomousPrelude).toBeUndefined();
    expect(wrapper().promptSnapshotLines).toBeUndefined();
  });

  it('should trust the physical launch folder with the measured projects table', () => {
    const text = (wrapper().trustFolderLines?.() ?? []).join('\n');
    expect(text).toContain('pwd -P');
    expect(text).toContain('set -- -c "projects={\\"$_fy_cwd\\"={trust_level=\\"trusted\\"}}" "$@"');
    expect(text).toContain('may ask whether to trust it');
  });
});
