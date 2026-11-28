/**
 * Codex's launch line comes from Codex's kit (E-276 PR 9): Runtimes writes the frame of the script and calls the kit's
 * members where it used to branch, and a Codex runtime whose plugin gives no launch line is REFUSED by name, never written
 * with Claude's lines or lines Runtimes still remembers.
 */
import { describe, expect, it } from 'bun:test';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import {
  autonomousPreparation,
  renderRuntimeWrapperScript,
  type RuntimeWrapperInput,
} from '../../../daemon/lib/wrappers.ts';

const REFUSAL = 'codex is not supported here';

/** A kit that answers with marker words, so the test can see which bytes came from it. */
const MARKED: RuntimesHarnessKit = {
  command: 'codex',
  homeEnv: 'CODEX_HOME',
  wrapper: {
    conversationArgs: 'marked-resume',
    modelArgs: model => ['--marked-model', model],
    quoteSection: text => `<${text}>`,
    instructionArgument: arg => (arg.startsWith('--marked-instructions=') ? { before: arg, after: '!' } : undefined),
    questionLines: () => ['echo marked-questions'],
    trustFolderLines: () => ['echo marked-trust'],
  },
};

const input = (overrides: Partial<RuntimeWrapperInput> = {}): RuntimeWrapperInput => ({
  name: 'codex-kit',
  id: '00000000-0000-4000-8000-0000000000bb',
  harness: 'codex',
  kit: MARKED,
  configDirectory: '/fy/homes/marked',
  env: {},
  args: ['--marked-instructions=words'],
  defaultModel: 'a-model',
  autonomous: { args: ['--marked-instructions=words'], seedFirstRun: false, trustLaunchFolder: true },
  fyCommand: 'fy',
  harnessCommand: '/opt/bin/codex',
  ...overrides,
});

describe('Codex launch line through the kit', () => {
  const text = renderRuntimeWrapperScript(input());

  it('should write the lines the kit gives, inside the frame Runtimes owns', () => {
    expect(text).toContain('case "$_fy_arg" in marked-resume) _fy_claim=1 ;; esac');
    expect(text).toContain('echo marked-trust');
    expect(text).toContain('echo marked-questions');
    expect(text).toContain("_fy_sections='<");
  });

  it('should start the model the kit names and join the sections between the two quoted halves', () => {
    expect(text).toContain(
      `exec '/opt/bin/codex' '--marked-model' 'a-model' '--marked-instructions=words'"$_fy_sections"'!' "$@"`,
    );
  });

  it('should write the trust lines only for an auto launch that asks for them', () => {
    const none = renderRuntimeWrapperScript(
      input({ autonomous: { args: [], seedFirstRun: false, trustLaunchFolder: false } }),
    );
    expect(none).not.toContain('marked-trust');
  });

  it('should drop the question-tool flag from the exec line when the kit names no argument of its own', () => {
    const flagged = renderRuntimeWrapperScript(input({ args: ['--disallowed-tools=AskUserQuestion', '--keep'] }));
    expect(flagged).not.toContain('AskUserQuestion');
    expect(flagged).toContain(`'--keep' "$@"`);
  });

  it('should refuse a Codex launch when the plugin gives no kit or no launch line', () => {
    expect(() => renderRuntimeWrapperScript(input({ kit: undefined }))).toThrow(REFUSAL);
    expect(() => renderRuntimeWrapperScript(input({ kit: {} }))).toThrow(REFUSAL);
  });

  it('should still say why a refused runtime cannot start, with no kit to ask', () => {
    const refused = renderRuntimeWrapperScript(input({ kit: undefined, refusal: 'it is off' }));
    expect(refused).toContain('codex-kit cannot start: it is off');
  });
});

describe('autonomousPreparation through the Codex kit', () => {
  it('should trust the folder only when the kit gives trust lines, and seed nothing', () => {
    expect(autonomousPreparation('codex', MARKED)).toEqual({ seedFirstRun: false, trustLaunchFolder: true });
    expect(autonomousPreparation('codex', { wrapper: { ...MARKED.wrapper!, trustFolderLines: undefined } })).toEqual({
      seedFirstRun: false,
      trustLaunchFolder: false,
    });
  });

  it('should refuse a Codex preparation when the plugin gives no launch line', () => {
    expect(() => autonomousPreparation('codex', undefined)).toThrow(REFUSAL);
    expect(() => autonomousPreparation('codex', {})).toThrow(REFUSAL);
  });
});
