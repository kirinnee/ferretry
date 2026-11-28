/**
 * Claude's launch line comes from Claude's kit (E-276 PR 8): Runtimes writes the frame of the script and calls the kit's
 * members where it used to branch, and a Claude runtime whose plugin gives no launch line is REFUSED by name, never written
 * with Codex's lines or lines Runtimes still remembers. Codex still branches here, so its launch never asks the Claude kit.
 */
import { describe, expect, it } from 'bun:test';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import {
  autonomousPreparation,
  renderRuntimeWrapperScript,
  type RuntimeWrapperInput,
} from '../../../daemon/lib/wrappers.ts';

const REFUSAL = 'claude is not supported here';

/** A kit that answers with marker words, so the test can see which bytes came from it. */
const MARKED: RuntimesHarnessKit = {
  wrapper: {
    conversationArgs: 'marked-resume|marked-resume=*',
    modelArgs: model => ['--marked-model', model],
    quoteSection: text => `<${text}>`,
    instructionArgument: arg => (arg.startsWith('--marked-instructions=') ? { before: arg, after: '!' } : undefined),
    questionLines: () => ['echo marked-questions'],
    suppliedArguments: ['--marked-supplied'],
    autonomousPrelude: input => [`echo marked-prelude ${input.homeEnv}`],
    promptSnapshotLines: command => [`echo marked-snapshot ${command}`],
  },
};

const input = (overrides: Partial<RuntimeWrapperInput> = {}): RuntimeWrapperInput => ({
  name: 'claude-kit',
  id: '00000000-0000-4000-8000-0000000000aa',
  harness: 'claude',
  kit: MARKED,
  configDirectory: '/fy/homes/marked',
  env: {},
  args: ['--marked-supplied', '--marked-instructions=words'],
  defaultModel: 'a-model',
  autonomous: {
    args: ['--marked-supplied', '--marked-instructions=words'],
    seedFirstRun: true,
    trustLaunchFolder: false,
  },
  fyCommand: 'fy',
  harnessCommand: '/opt/bin/claude',
  ...overrides,
});

describe('Claude launch line through the kit', () => {
  const text = renderRuntimeWrapperScript(input());

  it('should write the lines the kit gives, inside the frame Runtimes owns', () => {
    expect(text).toContain('echo marked-prelude CLAUDE_CONFIG_DIR');
    expect(text).toContain('case "$_fy_arg" in marked-resume|marked-resume=*) _fy_claim=1 ;; esac');
    expect(text).toContain('echo marked-questions');
    expect(text).toContain("echo marked-snapshot '/opt/bin/claude'");
    expect(text).toContain("_fy_sections='<");
  });

  it('should start the model the kit names, and drop the argument the wrapper supplies itself', () => {
    // The interactive launch carries the profile's arguments; the supplied flag is dropped from it too.
    expect(text).toContain(`exec '/opt/bin/claude' '--marked-model' 'a-model' '--marked-instructions=words' "$@"`);
    expect(text).not.toContain("'--marked-supplied'");
    const auto = text.slice(text.indexOf('if [ "${FY_SESSION_MODE:-}" = auto ]'));
    expect(auto).toContain("exec '/opt/bin/claude' '--marked-model' 'a-model'");
    expect(auto).not.toContain("'--marked-supplied'");
  });

  it('should join the sections between the two quoted halves the kit names, after a quoted tail', () => {
    expect(text).toContain(`'--marked-instructions=words'"$_fy_sections"'!'`);
  });

  it('should leave the sections off an argument the kit does not name', () => {
    const other = renderRuntimeWrapperScript(
      input({ autonomous: { args: ['--plain'], seedFirstRun: false, trustLaunchFolder: false } }),
    );
    expect(other).toContain('\'--plain\' "$@"');
    expect(other).not.toContain('marked-prelude');
  });

  it('should refuse a Claude launch when the plugin gives no kit or no launch line', () => {
    expect(() => renderRuntimeWrapperScript(input({ kit: undefined }))).toThrow(REFUSAL);
    expect(() => renderRuntimeWrapperScript(input({ kit: {} }))).toThrow(REFUSAL);
  });

  it('should still say why a refused runtime cannot start, with no kit to ask', () => {
    const refused = renderRuntimeWrapperScript(input({ kit: undefined, refusal: 'it is off' }));
    expect(refused).toContain('claude-kit cannot start: it is off');
  });

  it('should never ask the Claude kit for a Codex launch', () => {
    const codex = renderRuntimeWrapperScript(
      input({
        harness: 'codex',
        kit: MARKED,
        args: [],
        autonomous: { args: [], seedFirstRun: false, trustLaunchFolder: true },
      }),
    );
    expect(codex).not.toContain('marked-');
    expect(codex).toContain('case "$_fy_arg" in resume) _fy_claim=1 ;; esac');
    expect(codex).toContain(`'-c' 'model="a-model"'`);
  });
});

describe('autonomousPreparation through the kit', () => {
  it('should seed the first run only when the kit gives a prelude', () => {
    expect(autonomousPreparation('claude', MARKED).seedFirstRun).toBe(true);
    expect(
      autonomousPreparation('claude', { wrapper: { ...MARKED.wrapper!, autonomousPrelude: undefined } }).seedFirstRun,
    ).toBe(false);
  });

  it('should refuse a Claude preparation when the plugin gives no launch line', () => {
    expect(() => autonomousPreparation('claude', undefined)).toThrow(REFUSAL);
    expect(() => autonomousPreparation('claude', {})).toThrow(REFUSAL);
  });

  it('should not ask the kit about Codex', () => {
    expect(autonomousPreparation('codex', undefined)).toEqual({ seedFirstRun: false, trustLaunchFolder: true });
  });
});
