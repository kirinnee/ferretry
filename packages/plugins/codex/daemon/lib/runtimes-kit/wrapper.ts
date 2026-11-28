/**
 * Codex's launch line: the lines and arguments a runtime's wrapper script adds for Codex. Moved from Runtimes'
 * `wrappers.ts` with the text unchanged (E-276 PR 9); Runtimes still owns the script's frame (secrets, environment, the
 * history claim, the `exec`) and calls these members where it used to branch on the harness.
 *
 * The TOML spelling here is Runtimes' own (`tomlString` in its fixed layer), copied rather than shared: the plugin's
 * `./toml.ts` writes a newline as `\n` where the wrapper has always written `\u000a`, and the launch argv must stay
 * byte-identical.
 */
import type { KitInstructionArgument, RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';

/** The feature the question tool is switched by (`CODEX_QUESTIONS_FEATURE` in `../fixed-layer.ts`), spelled as one override. */
const QUESTIONS_OFF_OVERRIDE = 'features.default_mode_request_user_input=false';

/** The arguments that may name a conversation: Codex resumes with the `resume` word. */
const CONVERSATION_ARGUMENT_PATTERNS = 'resume';

/** A TOML basic string, for a value a Codex `-c` override carries: only the backslash and the double quote are escaped. */
const tomlBasicString = (value: string): string => `"${value.replace(/[\\"]/gu, character => `\\${character}`)}"`;

/** A TOML basic string with every control character escaped, as the wrapper has always written a section. */
const tomlString = (value: string): string => {
  const escaped = [...value]
    .map(character => {
      if (character === '\\') return '\\\\';
      if (character === '"') return '\\"';
      const code = character.codePointAt(0) as number;
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    })
    .join('');
  return `"${escaped}"`;
};

/** The launch arguments that start a runtime on its model set's default: a config override rather than `-m`, so a `-m` the caller passes still decides. */
const modelArgs = (model: string): readonly string[] => ['-c', `model=${tomlBasicString(model)}`];

/**
 * A per-ferret section as Codex's own argument carries it. Codex's value is a TOML basic string, so each section is stored
 * already escaped for one: escaping is per character, so escaped pieces join into the escaped whole.
 */
const quoteSection = (text: string): string => tomlString(text).slice(1, -1);

/**
 * The instruction argument, which takes this ferret's sections inside its closing quote: Codex's `developer_instructions="…"`;
 * `undefined` for any other argument.
 */
const instructionArgument = (arg: string): KitInstructionArgument | undefined =>
  !arg.startsWith('developer_instructions="') || !arg.endsWith('"')
    ? undefined
    : { before: arg.slice(0, -1), after: '"' };

/**
 * The question tool (owner !A527): Codex gets an explicit OFF, not silence: `-c features.default_mode_request_user_input=false`
 * always beats `config.toml`, where a selected settings component may have switched the feature on (the same spelling as the
 * Codex harness's launch, `CODEX_QUESTIONS_OFF`).
 */
const questionLines = (): readonly string[] => [`set -- -c ${QUESTIONS_OFF_OVERRIDE} "$@"`];

/**
 * Codex's trust for the folder it is launched in, built at launch because only then is the folder known: the measured TOML
 * inline table `projects={"<folder>"={trust_level="trusted"}}`, in shell.
 *
 * The folder is the PHYSICAL one (`pwd -P`), which is what Codex itself reads. Backslash and double quote are the two
 * characters a TOML basic string must escape; a folder holding a control character would need `\uXXXX` escapes the shell
 * cannot produce reliably, so it gets no override and says so — a trust prompt, never a malformed `-c` that stops Codex
 * starting.
 */
const trustFolderLines = (): readonly string[] => [
  '',
  '# Trust the launch folder (the measured -c projects={"<folder>"={trust_level="trusted"}} form).',
  '_fy_cwd="$(pwd -P 2>/dev/null)" || _fy_cwd="$PWD"',
  'case "$_fy_cwd" in',
  '  *[[:cntrl:]]*)',
  '    echo "ferretry: this folder\'s name holds a control character, so Codex may ask whether to trust it" >&2',
  '    ;;',
  '  *)',
  `    _fy_cwd="$(printf '%s' "$_fy_cwd" | sed 's/[\\\\"]/\\\\&/g')"`,
  '    set -- -c "projects={\\"$_fy_cwd\\"={trust_level=\\"trusted\\"}}" "$@"',
  '    ;;',
  'esac',
];

/** Codex's launch line. */
export const codexWrapperKit: RuntimesHarnessKit = {
  wrapper: {
    conversationArgs: CONVERSATION_ARGUMENT_PATTERNS,
    modelArgs,
    quoteSection,
    instructionArgument,
    questionLines,
    trustFolderLines,
  },
};
