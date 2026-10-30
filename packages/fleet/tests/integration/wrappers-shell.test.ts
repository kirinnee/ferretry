/**
 * The wrapper renderer's output RUN FOR REAL in `sh`: what a launch actually passes to its harness. These
 * cases need a real shell, so they are integration tests; `tests/unit/wrappers.test.ts` holds every case
 * that reads the rendered text alone.
 */
import { describe, it } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ROUTING_PROMPT_CHARS } from '@ferretry/protocol';
import should from 'should';
import {
  AGENDA_INSTRUCTION,
  AGENT_INSTRUCTION,
  AGENT_TOOLS_INSTRUCTION,
  BOARD_INSTRUCTION,
  CLAUDE_NO_QUESTIONS_FLAG,
  CODEX_QUESTIONS_FEATURE,
  fixedLayerFor,
  HYPERMEDIA_INSTRUCTION,
  LEAD_RULES_INSTRUCTION,
  LESSONS_INSTRUCTION,
  NOTIFY_INSTRUCTION,
  PACK_INSTRUCTION,
  SET_UP_FERRETRY_INSTRUCTION,
  SUB_FERRET_INSTRUCTION,
  TOOLS_SERVER_INSTRUCTIONS,
} from '../../src/lib/account/fixed-layer.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import { type RuntimeWrapperInput, renderRuntimeWrapperScript, shellQuote } from '../../src/lib/wrappers.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';

/** The facts these cases vary about one runtime; everything else is a fixed agent runtime. */
interface RuntimeFacts {
  readonly id?: string;
  readonly wrapper?: string;
  readonly kind?: HarnessKind;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly flags?: readonly string[];
}

const account = (overrides: RuntimeFacts = {}): RuntimeWrapperInput => {
  const harness = overrides.kind ?? 'claude';
  return {
    name: overrides.wrapper ?? 'claude-auto-kirin',
    id: overrides.id ?? ID_ONE,
    harness,
    agent: true,
    configDirectory: overrides.home ?? '$HOME/.state/fleet/homes/auto-kirin',
    env: overrides.env ?? {},
    args: overrides.flags ?? [],
    seedFirstRun: harness === 'claude',
    fyCommand: 'fy',
  };
};

/** The runtime renderer, with the secrets file a case names. */
const render = (input: RuntimeWrapperInput, options: { readonly secretsFile?: string } = {}): string =>
  renderRuntimeWrapperScript({ ...input, secretsFile: options.secretsFile });

/** What the wrapper's question line leaves in "$@" for a launch with the given mode, run for real in sh. */
const argumentsAfterQuestionLine = (wrapper: string, mode: string | undefined, launchArgs: readonly string[]) => {
  const line = wrapper.split('\n').find(candidate => candidate.includes('FY_SESSION_MODE'));
  if (line === undefined) return undefined;
  const { stdout } = Bun.spawnSync(['sh', '-c', `${line}\nprintf '%s\\n' "$@"`, 'wrapper', ...launchArgs], {
    env: mode === undefined ? {} : { FY_SESSION_MODE: mode },
  });
  return stdout.toString().trimEnd().split('\n');
};

describe('the question tool, per ferret (O3)', () => {
  it("should withhold Claude's question tool, before the prompt, unless the ferret is interactive", () => {
    // Arrange
    const wrapper = render(account({ flags: [CLAUDE_NO_QUESTIONS_FLAG, '--model', 'x'] }));

    // Act + Assert
    should(wrapper).not.containEql(`'${CLAUDE_NO_QUESTIONS_FLAG}'`);
    should(argumentsAfterQuestionLine(wrapper, 'auto', ['do the thing'])).deepEqual([
      CLAUDE_NO_QUESTIONS_FLAG,
      'do the thing',
    ]);
    should(argumentsAfterQuestionLine(wrapper, undefined, ['do the thing'])).deepEqual([
      CLAUDE_NO_QUESTIONS_FLAG,
      'do the thing',
    ]);
    should(argumentsAfterQuestionLine(wrapper, 'interactive', ['do the thing'])).deepEqual(['do the thing']);
  });

  it("should enable Codex's question feature only for an interactive ferret", () => {
    // Arrange
    const wrapper = render(account({ kind: 'codex' }));

    // Act + Assert
    should(argumentsAfterQuestionLine(wrapper, 'interactive', ['task'])).deepEqual([
      '--enable',
      CODEX_QUESTIONS_FEATURE,
      'task',
    ]);
    should(argumentsAfterQuestionLine(wrapper, 'auto', ['task'])).deepEqual(['task']);
    should(argumentsAfterQuestionLine(wrapper, undefined, ['task'])).deepEqual(['task']);
  });

  it("should leave a non-agent runtime alone: it behaves like the person's own CLI", () => {
    // Arrange
    const wrapper = render({ ...account(), agent: false });

    // Act + Assert
    should(argumentsAfterQuestionLine(wrapper, 'auto', ['task'])).be.undefined();
  });
});

/**
 * A folder holding stand-in `claude` and `codex` executables whose `--help` prints `help`, so what the
 * wrapper asks of the installed harness is this test's answer and never the host's.
 */
const fakeHarnesses = (help: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'fy-wrapper-harness-'));
  for (const name of ['claude', 'codex']) {
    const file = join(directory, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(help)}\n`);
    chmodSync(file, 0o755);
  }
  return directory;
};

/** A harness that predates the system-prompt record, and so has no switch for it. */
const OLD_HARNESS = fakeHarnesses('Usage: claude [options]\n  --append-system-prompt <prompt>');

/** The arguments the rendered wrapper would exec its harness with, run for real in sh with `env`. */
const launchArguments = (
  wrapper: string,
  env: Readonly<Record<string, string>>,
  harnesses: string = OLD_HARNESS,
): readonly string[] => {
  const script = wrapper.replace(/^exec (?:claude|codex) /mu, "printf '%s\\0' ");
  const { stdout } = Bun.spawnSync(['sh', '-c', script, 'wrapper', 'the task'], {
    env: { PATH: `${harnesses}:${process.env.PATH ?? ''}`, HOME: '/nonexistent', FY_SEED_FIRST_RUN: '0', ...env },
  });
  return stdout.toString().split('\0').slice(0, -1);
};

describe("a resumed conversation hears this launch's sections", () => {
  const BASE = 'Ferretry tools: the base instruction.';
  const RECORDING_HARNESS = fakeHarnesses(
    'Usage: claude [options]\n  --system-prompt-snapshot <on|off>     Record the system prompt once per conversation',
  );

  it("should turn Claude's system-prompt record off where the installed Claude keeps one", () => {
    // Arrange — a Restart relaunches into the conversation it is bound to.
    const wrapper = render(account({ flags: [`--append-system-prompt=${BASE}`] }));

    // Act
    const args = launchArguments(wrapper, { FY_HYPERMEDIA: '1' }, RECORDING_HARNESS);

    // Assert — the record would otherwise replay the first launch's prompt, without this section.
    should(args).containEql('--system-prompt-snapshot=off');
    should(args.find(arg => arg.startsWith('--append-system-prompt='))).containEql('\n\nHypermedia:');
    should(args.at(-1)).equal('the task');
  });

  it('should pass nothing new to a Claude without the switch, which would refuse a flag it does not know', () => {
    // Act
    const args = launchArguments(render(account({ flags: [`--append-system-prompt=${BASE}`] })), {});

    // Assert
    should(args.filter(arg => arg.includes('system-prompt-snapshot'))).be.empty();
    should(args.at(-1)).equal('the task');
  });

  it('should give up on a harness that answers --help by starting a session, and still launch', () => {
    // Arrange — a stand-in that, like a harness taking `--help` for a prompt, never exits (it sleeps an hour),
    // so a wrapper that waited for it never launches and the test times out; no clock reading is needed to tell
    // the two apart. The wrapper's own three-second patience is pinned below, then run at a tenth of it: the
    // kill the patience ends in is the same, and the case no longer waits out three seconds of nothing.
    const directory = mkdtempSync(join(tmpdir(), 'fy-wrapper-hang-'));
    const file = join(directory, 'claude');
    writeFileSync(file, '#!/bin/sh\nprintf "> "\nwhile IFS= read -r _turn; do :; done\nexec sleep 3600\n');
    chmodSync(file, 0o755);

    // Act
    const wrapper = render(account({ flags: [`--append-system-prompt=${BASE}`] }));
    const args = launchArguments(wrapper.replace('{ sleep 3; kill', '{ sleep 0.3; kill'), {}, directory);

    // Assert
    should(wrapper).containEql('{ sleep 3; kill "$_fy_p"; }');
    should(wrapper.replace('{ sleep 3; kill', '{ sleep 0.3; kill')).not.equal(wrapper);
    should(args.filter(arg => arg.includes('system-prompt-snapshot'))).be.empty();
    should(args.at(-1)).equal('the task');
  });

  it('should ask the harness the wrapper execs, and leave Codex and a non-agent runtime alone', () => {
    // Arrange
    const agent = account({ flags: [`--append-system-prompt=${BASE}`] });

    // Act
    const resolved = render({ ...agent, harnessCommand: '/opt/harnesses/claude' });
    const codex = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));
    const person = render({ ...agent, agent: false });

    // Assert
    should(resolved).containEql("_fy_help=\"$({ '/opt/harnesses/claude' --help </dev/null");
    should(launchArguments(codex, {}, RECORDING_HARNESS)).not.containEql('--system-prompt-snapshot=off');
    should(codex).not.containEql('system-prompt-snapshot');
    should(person).not.containEql('system-prompt-snapshot');
  });
});

describe("each ferret's sections of the appended system prompt", () => {
  const BASE = 'Ferretry tools: the base instruction.';
  const LEAD = `${BASE}\n\n${LEAD_RULES_INSTRUCTION('fy')}`;

  it('should append exactly the sections this ferret switched on, after a blank line, in the fixed order', () => {
    // Arrange
    const wrapper = render(account({ flags: [`--append-system-prompt=${BASE}`, '--model', 'x'] }));
    const prompt = (env: Readonly<Record<string, string>>): string | undefined =>
      launchArguments(wrapper, env).find(arg => arg.startsWith('--append-system-prompt='));

    // Act
    const none = prompt({});
    const off = prompt({ FY_HYPERMEDIA: '0', FY_PACK: '0', FY_AGENDA: '0', FY_LEARNING_PASSIVE: '0' });
    const pack = prompt({ FY_PACK: '1' });
    const agenda = prompt({ FY_AGENDA: '1' });
    const all = prompt({ FY_HYPERMEDIA: '1', FY_PACK: '1', FY_AGENDA: '1', FY_LEARNING_PASSIVE: '1' });

    // Assert
    should(none).equal(`--append-system-prompt=${LEAD}`);
    should(off).equal(none);
    should(pack).startWith(`--append-system-prompt=${LEAD}\n\nPack mode: `);
    should(pack).not.containEql('Hypermedia:');
    should(all?.indexOf('\n\nHypermedia:')).be.above(0);
    should(all?.indexOf('\n\nPack mode:')).be.above(all?.indexOf('\n\nHypermedia:') ?? 0);
    should(all?.indexOf('\n\nAgenda mode:')).be.above(all?.indexOf('\n\nPack mode:') ?? 0);
    should(all?.indexOf('\n\nLessons:')).be.above(all?.indexOf('\n\nAgenda mode:') ?? 0);
    should(agenda).startWith(`--append-system-prompt=${LEAD}\n\nAgenda mode: `);
    should(none).not.containEql('Agenda mode:');
    should(off).not.containEql('Agenda mode:');
    should(all).containEql('`fy lesson suggest');
  });

  it("should put Codex's sections inside the TOML string, escaped for it", () => {
    // Arrange
    const wrapper = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));

    // Act
    const args = launchArguments(wrapper, { FY_PACK: '1' });
    const value = args.find(arg => arg.startsWith('developer_instructions='));

    // Assert
    should(value).startWith('developer_instructions="');
    should(value).endWith('"');
    should(value?.slice('developer_instructions='.length)).match(/^"(?:[^"\\]|\\.)*"$/u);
    should(JSON.parse(value?.slice('developer_instructions='.length) ?? '')).startWith(`${LEAD}\n\nPack mode: `);
  });

  it('should give a sub-ferret its two lines in place of the lead rules and the agenda section', () => {
    // Arrange
    const wrapper = render(account({ flags: [`--append-system-prompt=${BASE}`] }));
    const prompt = (env: Readonly<Record<string, string>>): string | undefined =>
      launchArguments(wrapper, env).find(arg => arg.startsWith('--append-system-prompt='));

    // Act
    const sub = prompt({ FY_SUB_FERRET: '1', FY_AGENDA: '1', FY_PACK: '1' });

    // Assert
    should(sub).startWith(`--append-system-prompt=${BASE}\n\n${SUB_FERRET_INSTRUCTION('fy')}\n\nPack mode: `);
    should(sub).not.containEql('Agenda mode:');
    should(sub).not.containEql('Board: all work');
    should(sub).not.containEql('Notify: the owner');
    should(prompt({ FY_SUB_FERRET: '0', FY_AGENDA: '1' })).containEql('Agenda mode:');
  });

  it("should end the Pack section with the routing prompt's line, for Claude and inside Codex's TOML string", () => {
    // Arrange
    const line =
      'Routing: Planning and review: claude-opus-5-5 at max. Chores: claude-haiku-5-5 low; when it is low, glm-5-air.';
    const claude = render(account({ flags: [`--append-system-prompt=${BASE}`] }));
    const codex = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));

    // Act
    const claudePrompt = launchArguments(claude, { FY_PACK: '1', FY_PACK_ROUTING: line }).find(arg =>
      arg.startsWith('--append'),
    );
    const codexValue = launchArguments(codex, { FY_PACK: '1', FY_PACK_ROUTING: line }).find(arg =>
      arg.startsWith('developer_instructions='),
    );

    // Assert
    should(claudePrompt).endWith(`${PACK_INSTRUCTION('fy')}\n${line}`);
    should(JSON.parse(codexValue?.slice('developer_instructions='.length) ?? '')).endWith(
      `${PACK_INSTRUCTION('fy')}\n${line}`,
    );
  });

  it('should carry no routing line with Pack mode off or no line set, and strip what would break the quoting', () => {
    // Arrange
    const codex = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));
    const claude = render(account({ flags: [`--append-system-prompt=${BASE}`] }));
    const prompt = (env: Record<string, string>) =>
      launchArguments(claude, env).find(arg => arg.startsWith('--append')) ?? '';

    // Act
    const hostile = launchArguments(codex, { FY_PACK: '1', FY_PACK_ROUTING: 'a"b\\c\nd\te' }).find(arg =>
      arg.startsWith('developer_instructions='),
    );

    // Assert
    should(prompt({ FY_PACK: '0', FY_PACK_ROUTING: 'Routing: x.' })).not.containEql('Routing: x.');
    should(prompt({ FY_PACK: '1' })).endWith(PACK_INSTRUCTION('fy'));
    should(prompt({ FY_PACK: '1', FY_PACK_ROUTING: '' })).endWith(PACK_INSTRUCTION('fy'));
    should(hostile?.slice('developer_instructions='.length)).match(/^"(?:[^"\\]|\\.)*"$/u);
    should(JSON.parse(hostile?.slice('developer_instructions='.length) ?? '')).endWith('\nabcde');
  });

  it('should name the binary the runtime launches, and leave every other argument and a non-agent alone', () => {
    // Arrange
    const agent = {
      ...account({ flags: [`--append-system-prompt=${BASE}`, '--other=x'] }),
      fyCommand: '/opt/f/bin/zz',
    };
    const person = { ...agent, agent: false };

    // Act
    const prompt = launchArguments(render(agent), { FY_PACK: '1' }).find(arg => arg.startsWith('--append'));

    // Assert
    should(prompt).containEql('`zz recommend');
    should(launchArguments(render(agent), {})).containEql('--other=x');
    should(render(person)).not.containEql('_fy_sections');
  });
});

describe('the appended system prompt of a real agent runtime, for every combination of switches', () => {
  const FY = '/opt/f/bin/fy';
  const SWITCHES = [
    { env: 'FY_HYPERMEDIA', text: HYPERMEDIA_INSTRUCTION('fy') },
    { env: 'FY_PACK', text: PACK_INSTRUCTION('fy') },
    { env: 'FY_AGENDA', text: AGENDA_INSTRUCTION('fy') },
    { env: 'FY_LEARNING_PASSIVE', text: LESSONS_INSTRUCTION('fy') },
  ] as const;
  const combinations = Array.from({ length: 2 ** SWITCHES.length }, (_, mask) =>
    SWITCHES.filter((_switch, index) => (mask & (1 << index)) !== 0),
  );
  const wrapperFor = (harness: HarnessKind): string => {
    const layer = fixedLayerFor({
      harness,
      agentPermissions: 'auto',
      cwd: '/w',
      fyCommand: FY,
      acceptsAutoPermissionMode: true,
    });
    if (!layer.ok) throw new Error(layer.refusal.message);
    return render({ ...account({ kind: harness, flags: layer.layer.args }), fyCommand: FY });
  };

  it.each(combinations.flatMap(on => (['claude', 'codex'] as const).map(harness => [harness, on] as const)))(
    'should give a %s ferret exactly the sections switched on: %j',
    (harness, on) => {
      // Arrange
      const env = Object.fromEntries(SWITCHES.map(section => [section.env, on.includes(section) ? '1' : '0']));
      const expected = [AGENT_INSTRUCTION('fy'), ...on.map(section => section.text)].join('\n\n');

      // Act
      const args = launchArguments(wrapperFor(harness), env);
      const prompt =
        harness === 'claude'
          ? args.find(arg => arg.startsWith('--append-system-prompt='))?.slice('--append-system-prompt='.length)
          : JSON.parse(
              args.find(arg => arg.startsWith('developer_instructions='))?.slice('developer_instructions='.length) ??
                '""',
            );

      // Assert
      should(prompt).equal(expected);
      should(args.filter(arg => arg.includes('Pack mode:')).length).equal(on.some(s => s.env === 'FY_PACK') ? 1 : 0);
    },
  );

  it.each(['claude', 'codex'] as const)(
    'should give a %s ferret the notify rule, and not the agenda, even with every switch off',
    harness => {
      // Arrange
      const env = Object.fromEntries(SWITCHES.map(section => [section.env, '0']));

      // Act
      const args = launchArguments(wrapperFor(harness), env);
      const prompt =
        harness === 'claude'
          ? args.find(arg => arg.startsWith('--append-system-prompt='))?.slice('--append-system-prompt='.length)
          : JSON.parse(
              args.find(arg => arg.startsWith('developer_instructions='))?.slice('developer_instructions='.length) ??
                '""',
            );

      // Assert — the binary is named by the wrapper's own command, never a hard-coded name
      should(prompt).containEql(NOTIFY_INSTRUCTION('fy'));
      should(prompt).containEql('`fy notify "<summary>" [--body "<detail>"]`');
      should(prompt).not.containEql('Agenda mode:');
    },
  );

  it('should keep every section out of the tools server, which says one line', () => {
    // Assert
    should(TOOLS_SERVER_INSTRUCTIONS).not.containEql('\n');
    should(TOOLS_SERVER_INSTRUCTIONS.length).be.below(160);
    for (const section of [...SWITCHES, { text: SET_UP_FERRETRY_INSTRUCTION('fy') }])
      should(TOOLS_SERVER_INSTRUCTIONS).not.containEql(section.text.slice(0, 20));
  });

  it('should stay compact: the measured size of each section', () => {
    // Act
    const sizes = {
      tools: AGENT_TOOLS_INSTRUCTION.length,
      settings: SET_UP_FERRETRY_INSTRUCTION('fy').length,
      notify: NOTIFY_INSTRUCTION('fy').length,
      board: BOARD_INSTRUCTION('fy').length,
      hypermedia: HYPERMEDIA_INSTRUCTION('fy').length,
      pack: PACK_INSTRUCTION('fy').length,
      agenda: AGENDA_INSTRUCTION('fy').length,
      lessons: LESSONS_INSTRUCTION('fy').length,
    };

    // Assert — the whole prompt, every section on and the longest routing prompt as its one `Routing: ` line,
    // stays under 7.4 KB (docs/pack-mode.md records the sizes: raised from 6.7 KB for Attention's steps and
    // hypermedia's `chart`; the notify rule replaced Attention's 1 KB, Agenda mode adds its own section). The
    // Board section (640) was paid for by naming the tools by prefix, moving map, media and chart's full spec
    // behind `fy render guide`, and compressing the lessons rule: 7,245 measured (the reply-parks-the-item wording, which now says to refresh the whole card), so keep 150 of headroom.
    const longestRouting = 1 + 'Routing: '.length + MAX_ROUTING_PROMPT_CHARS;
    should(Object.values(sizes).reduce((sum, size) => sum + size, 0) + longestRouting).be.below(7_400 - 150);
    should(sizes.pack).be.below(1_050);
    should(sizes.tools).be.below(850);
    should(sizes.board).be.below(660);
    should(sizes.hypermedia).be.below(1_550);
    should(sizes.lessons).be.below(270);
    should(sizes.settings).be.below(600);
    should(sizes.notify).be.below(450);
    should(sizes.agenda).be.below(1_300);
  });

  it('should tell every ferret to hand the owner a terminal or page, driven as far as it goes, rather than describe the step', () => {
    // Assert
    for (const phrase of [
      'sudo or password prompt',
      'OAuth or device-code login',
      'gh auth login',
      '2FA',
      'captcha',
      'open the terminal or page',
      'ask_owner',
      'askOwner',
      'exactly what to do',
      'Never put a secret in chat',
      'terminal_ask_owner',
      'browser_ask_owner',
    ])
      should(AGENT_TOOLS_INSTRUCTION).containEql(phrase);
  });
});
