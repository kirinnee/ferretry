import { describe, test } from 'bun:test';
import should from 'should';
import { classifySystemText } from '../../src/lib/system-blocks.ts';

// The fixtures below are the shapes mined from real `chat.jsonl` records during
// the kteam port (its `src/lib/system-blocks.test.ts`), reproduced here so the
// classifier is proved against what both harnesses actually emit rather than
// idealised text. The two fixtures that read real transcript files in kteam are
// replaced by inline payloads with the same structure — see
// `real Claude/Codex compaction shape` below.

const TASK_NOTIFICATION_STOPPED = `<task-notification>
<task-id>b1oj3g688</task-id>
<tool-use-id>toolu_01PgyNK8V9nw6B9fE15b3b7Z</tool-use-id>
<status>stopped</status>
<summary>No completion record was found for this background shell command from the previous session. It may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or it may have been running when the previous process exited. Check the output file for partial results before assuming it completed.</summary>
</task-notification>`;

const TASK_NOTIFICATION_COMPLETED = `<task-notification>
<task-id>bywg8or5y</task-id>
<status>completed</status>
<summary>Background command "Run all 15 probes in background" completed (exit code 0)</summary>
</task-notification>`;

const TASK_NOTIFICATION_WITH_RESULT = `<task-notification>
<task-id>zzz</task-id>
<status>failed</status>
<result>Exit code 2
some more result detail on a second line</result>
</task-notification>`;

const TASK_NOTIFICATION_SUMMARY_AND_RESULT = `<task-notification>
<task-id>qqq</task-id>
<status>completed</status>
<result>3 passed, 0 failed
(trailing detail)</result>
<summary>Background command "run the suite" completed (exit code 0)</summary>
</task-notification>`;

const TASK_NOTIFICATION_KILLED = `<task-notification>
<status>killed</status>
</task-notification>`;

const TASK_NOTIFICATION_BARE = `<task-notification>
<task-id>nnn</task-id>
</task-notification>`;

const ENVIRONMENT_CONTEXT = `<environment_context>
  <cwd>/home/kirin/Workspace/personal/ferretry</cwd>
  <shell>zsh</shell>
  <current_date>2026-07-22</current_date>
</environment_context>`;

const TURN_PROMPT = `Read the file /home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/turns/turn-001.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`;

const TURN_PROMPT_FERRETRY = `Read the file /home/kirin/.ferretry/state/sessions/fy0v8vgc/turns/turn-007.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`;

const TURN_PROMPT_MAC = `Read the file /Users/erng/agents/abc-123/turns/turn-042.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`;

const TURN_PROMPT_WIN = `Read the file C:\\Users\\erng\\state\\abc-123\\turns\\turn-002.md now, then carefully follow every instruction inside it.`;

const LIVENESS = `Liveness check: no output, pane change, or subprocess activity has been observed for several minutes. If you are alive, continue the task now.`;
const AUTOMODE = `Automode: do not wait for user input. Make the best reasonable decision, continue the task, and write the required done marker when complete.`;
const CONTINUE = `Continue from where you left off.`;
const IMAGE_META = `[Image: original 1138x2151, displayed at 1058x2000. Multiply coordinates by 1.08 to map to original image.]`;

// Daemon "declared wait elapsed" notice. Fixed prefix + suffix, only the
// parenthesized condition varies.
const WAIT_ELAPSED_REAL = `The wait you declared has elapsed (peer reply from bennett on the review thread). Re-check the condition and continue the task.`;
const WAIT_ELAPSED_NONE = `The wait you declared has elapsed (no condition given). Re-check the condition and continue the task.`;
const WAIT_ELAPSED_EMPTY = `The wait you declared has elapsed (). Re-check the condition and continue the task.`;

const SYSTEM_REMINDER = `<system-reminder>
The user has changed their mind about the approach. Prefer the smaller diff.
</system-reminder>`;

const SYSTEM_REMINDER_TAGS_ONLY = `<system-reminder>
<nested>only tags in here</nested>
</system-reminder>`;

const COMPACTION = `This session is being continued from a previous conversation that ran out of context. Below is a summary of the conversation so far.

Summary:
1. Primary Request and Intent: the user asked to refactor the transcript renderer and we split it into blocks.

More detail follows across many lines...`;

// The shape of a real Claude compaction payload: an explicit `Summary` header
// followed by a numbered section heading that must be skipped.
const COMPACTION_CLAUDE_SHAPE = `This session is being continued from a previous conversation that ran out of context.

Summary:
1. **Primary Request and Intent:**
The session was launched as a teammate on the migration and asked to port the chat surface.`;

// The shape of a real Codex compaction payload: no explicit header, Markdown
// section headings that must be skipped.
const COMPACTION_CODEX_SHAPE = `Another language model started to solve this problem and produced a summary of its work:
## Checkpoint
Worktree: /home/kirin/Workspace/personal/ferretry-wt-pwachat on port/pwachat.`;

// Every candidate line is a heading, so no summary can be derived.
const COMPACTION_ALL_HEADINGS = `This session is being continued from a previous conversation.
Summary:
## Checkpoint
### Details:`;

const COMMAND_INLINE = `<command-name>/compact</command-name>`;

const COMMAND_SIBLINGS = `<command-message>compacting is running…</command-message>
<command-name>/compact</command-name>
<command-args></command-args>`;

const LOCAL_COMMAND_STDOUT = `<local-command-stdout>everything is up to date</local-command-stdout>`;

const LOCAL_COMMAND_STDERR = `<local-command-stderr>warning: nothing to do</local-command-stderr>`;

describe('classifySystemText — task notification', () => {
  test('should keep the status, derive a warn tone and summarise <summary> for a stopped task', () => {
    // Act
    const info = classifySystemText(TASK_NOTIFICATION_STOPPED);

    // Assert
    should(info).not.be.null();
    should(info?.label).equal('task notification');
    should(info?.status).equal('stopped');
    should(info?.tone).equal('warn');
    should(info?.summary).containEql('No completion record was found');
    should(info?.raw).equal(TASK_NOTIFICATION_STOPPED);
  });

  test('should derive an ok tone for a completed task', () => {
    // Act
    const info = classifySystemText(TASK_NOTIFICATION_COMPLETED);

    // Assert
    should(info?.status).equal('completed');
    should(info?.tone).equal('ok');
    should(info?.summary).containEql('Run all 15 probes');
  });

  test('should derive an err tone and summarise the first <result> line for a failed task', () => {
    // Act
    const info = classifySystemText(TASK_NOTIFICATION_WITH_RESULT);

    // Assert
    should(info?.status).equal('failed');
    should(info?.tone).equal('err');
    should(info?.summary).equal('Exit code 2');
  });

  test('should derive an err tone for a killed task', () => {
    // Act
    const info = classifySystemText(TASK_NOTIFICATION_KILLED);

    // Assert
    should(info?.tone).equal('err');
    should(info?.summary).be.undefined();
  });

  test('should classify a notification with no status and leave the tone unset', () => {
    // Act
    const info = classifySystemText(TASK_NOTIFICATION_BARE);

    // Assert
    should(info?.label).equal('task notification');
    should(info?.status).be.undefined();
    should(info?.tone).be.undefined();
  });

  test('should surface both <summary> and the first <result> line when both are present', () => {
    // Act
    const info = classifySystemText(TASK_NOTIFICATION_SUMMARY_AND_RESULT);

    // Assert
    should(info?.summary).containEql('run the suite');
    should(info?.summary).containEql('3 passed, 0 failed');
  });

  test('should collapse the summary to a single line', () => {
    // Act
    const info = classifySystemText(TASK_NOTIFICATION_STOPPED);

    // Assert
    should(info?.summary).not.containEql('\n');
    should(info?.summary?.endsWith('…')).be.true();
  });

  test('should not repeat a <result> line that duplicates the <summary>', () => {
    // Arrange
    const text = `<task-notification>\n<status>completed</status>\n<summary>done</summary>\n<result>done</result>\n</task-notification>`;

    // Act
    const info = classifySystemText(text);

    // Assert
    should(info?.summary).equal('done');
  });
});

describe('classifySystemText — other harness wrappers', () => {
  test('should label a system-reminder and summarise its first non-tag line', () => {
    // Act
    const info = classifySystemText(SYSTEM_REMINDER);

    // Assert
    should(info?.label).equal('system reminder');
    should(info?.summary).containEql('changed their mind');
    should(info?.raw).equal(SYSTEM_REMINDER);
  });

  test('should label a system-reminder with no prose and leave the summary unset', () => {
    // Act
    const info = classifySystemText(SYSTEM_REMINDER_TAGS_ONLY);

    // Assert
    should(info?.label).equal('system reminder');
    should(info?.summary).be.undefined();
  });

  test('should classify a turn prompt and summarise the turn file', () => {
    // Act
    const info = classifySystemText(TURN_PROMPT);

    // Assert
    should(info?.label).equal('turn prompt');
    should(info?.summary).equal('turn-001.md');
    should(info?.raw).equal(TURN_PROMPT);
  });

  test('should classify a turn prompt from a second session in the same state home', () => {
    // Act
    const info = classifySystemText(TURN_PROMPT_FERRETRY);

    // Assert
    should(info?.label).equal('turn prompt');
    should(info?.summary).equal('turn-007.md');
  });

  test('should classify a turn prompt under a relocated state home', () => {
    // Act
    const info = classifySystemText(TURN_PROMPT_MAC);

    // Assert
    should(info?.label).equal('turn prompt');
    should(info?.summary).equal('turn-042.md');
  });

  test('should classify a Windows turn prompt path with backslash separators', () => {
    // Act
    const info = classifySystemText(TURN_PROMPT_WIN);

    // Assert
    should(info?.label).equal('turn prompt');
    should(info?.summary).equal('turn-002.md');
  });

  test('should leave a human sentence mentioning a turn file as a user message', () => {
    // Act
    const info = classifySystemText('please open /Users/me/state/x/turns/turn-003.md and tell me what it says');

    // Assert
    should(info).be.null();
  });

  test('should classify an interrupt notice with a warn tone', () => {
    // Act
    const info = classifySystemText('[Request interrupted by user]');

    // Assert
    should(info?.label).equal('interrupted');
    should(info?.tone).equal('warn');
    should(info?.summary).equal('[Request interrupted by user]');
  });

  test('should classify a tool-use interrupt notice', () => {
    // Act
    const info = classifySystemText('[Request interrupted by user for tool use]');

    // Assert
    should(info?.label).equal('interrupted');
  });

  test('should summarise a compaction opener with the first useful line after the header', () => {
    // Act
    const info = classifySystemText(COMPACTION);

    // Assert
    should(info?.label).equal('context compacted');
    should(info?.divider).equal('compaction');
    should(info?.summary).containEql('refactor the transcript renderer');
    should(info?.summary?.toLowerCase()).not.equal('summary:');
    should(info?.summary?.startsWith('1.')).be.false();
  });

  test('should fall back to fixed copy when a compaction opener carries no summary', () => {
    // Act
    const info = classifySystemText('This session is being continued from a previous conversation. Nothing else.');

    // Assert
    should(info?.label).equal('context compacted');
    should(info?.summary).equal('earlier conversation summarised');
  });

  test('should skip a numbered section heading in a Claude-shaped compaction payload', () => {
    // Act
    const info = classifySystemText(COMPACTION_CLAUDE_SHAPE);

    // Assert
    should(info?.label).equal('context compacted');
    should(info?.divider).equal('compaction');
    should(info?.summary?.startsWith('The session was launched as a teammate')).be.true();
    should(info?.summary).not.containEql('Primary Request and Intent');
  });

  test('should skip a Markdown heading in a Codex-shaped compaction payload', () => {
    // Act
    const info = classifySystemText(COMPACTION_CODEX_SHAPE);

    // Assert
    should(info?.label).equal('context compacted');
    should(info?.summary?.startsWith('Worktree:')).be.true();
    should(info?.summary).not.containEql('Checkpoint');
  });

  test('should fall back to fixed copy when every candidate line is a heading', () => {
    // Act
    const info = classifySystemText(COMPACTION_ALL_HEADINGS);

    // Assert
    should(info?.summary).equal('earlier conversation summarised');
  });
});

describe('classifySystemText — daemon-injected automode plumbing', () => {
  test('should classify the liveness nudge and retain the raw text', () => {
    // Act
    const info = classifySystemText(LIVENESS);

    // Assert
    should(info?.label).equal('liveness');
    should(info?.summary).equal('no recent activity — continuing');
    should(info?.raw).equal(LIVENESS);
  });

  test('should classify the automode notice', () => {
    // Act
    const info = classifySystemText(AUTOMODE);

    // Assert
    should(info?.label).equal('automode');
    should(info?.summary).equal('do not wait for input');
    should(info?.raw).equal(AUTOMODE);
  });

  test('should classify the bare continue nudge', () => {
    // Act
    const info = classifySystemText(CONTINUE);

    // Assert
    should(info?.label).equal('continue');
    should(info?.summary).equal('resume where left off');
  });

  test('should leave a continue nudge with extra prose as a user message', () => {
    // Act — a human who types more than the bare daemon nudge keeps their message.
    const info = classifySystemText('Continue from where you left off. Also add a test.');

    // Assert
    should(info).be.null();
  });

  test('should leave a human paraphrase of liveness or automode as a user message', () => {
    // Act
    const liveness = classifySystemText('are you still alive? please continue the task');
    const automode = classifySystemText('in automode you should not wait for me');

    // Assert
    should(liveness).be.null();
    should(automode).be.null();
  });

  test('should classify image-attachment metadata with its original dimensions', () => {
    // Act
    const info = classifySystemText(IMAGE_META);

    // Assert
    should(info?.label).equal('image');
    should(info?.summary).equal('original 1138x2151');
    should(info?.raw).equal(IMAGE_META);
  });

  test('should leave image metadata followed by human prose as a user message', () => {
    // Act
    const info = classifySystemText('[Image: original 800x600, displayed at 400x300.] what is wrong with this?');

    // Assert
    should(info).be.null();
  });
});

describe('classifySystemText — daemon declared-wait notice', () => {
  test('should surface the parenthesized condition', () => {
    // Act
    const info = classifySystemText(WAIT_ELAPSED_REAL);

    // Assert
    should(info?.label).equal('wait elapsed');
    should(info?.summary).equal('peer reply from bennett on the review thread');
    should(info?.raw).equal(WAIT_ELAPSED_REAL);
  });

  test('should surface the daemon placeholder verbatim', () => {
    // Act
    const info = classifySystemText(WAIT_ELAPSED_NONE);

    // Assert
    should(info?.summary).equal('no condition given');
  });

  test('should fall back to fixed copy for an empty condition', () => {
    // Act
    const info = classifySystemText(WAIT_ELAPSED_EMPTY);

    // Assert
    should(info?.label).equal('wait elapsed');
    should(info?.summary).equal('no condition given');
  });

  test('should leave the prefix without the fixed suffix as a user message', () => {
    // Act
    const info = classifySystemText('The wait you declared has elapsed, so I moved on.');

    // Assert
    should(info).be.null();
  });

  test('should leave a mid-sentence quotation of the notice as a user message', () => {
    // Act
    const info = classifySystemText(
      'Note: "The wait you declared has elapsed (x). Re-check the condition and continue the task." is the daemon line.',
    );

    // Assert
    should(info).be.null();
  });
});

describe('classifySystemText — local slash-command markers', () => {
  test('should label an inline command-name pair with the slash command', () => {
    // Act
    const info = classifySystemText(COMMAND_INLINE);

    // Assert
    should(info?.label).equal('command');
    should(info?.summary).equal('/compact');
    should(info?.raw).equal(COMMAND_INLINE);
  });

  test('should prefer command-name over command-message in a sibling bundle', () => {
    // Act
    const info = classifySystemText(COMMAND_SIBLINGS);

    // Assert
    should(info?.label).equal('command');
    should(info?.summary).equal('/compact');
  });

  test('should summarise a bare local-command-stdout block from its output', () => {
    // Act
    const info = classifySystemText(LOCAL_COMMAND_STDOUT);

    // Assert
    should(info?.label).equal('command');
    should(info?.summary).equal('everything is up to date');
  });

  test('should summarise a bare local-command-stderr block from its output', () => {
    // Act
    const info = classifySystemText(LOCAL_COMMAND_STDERR);

    // Assert
    should(info?.label).equal('command');
    should(info?.summary).equal('warning: nothing to do');
  });

  test('should leave a command marker with no closing tag as a user message', () => {
    // Act
    const info = classifySystemText('<command-name>/compact');

    // Assert
    should(info).be.null();
  });

  test('should leave a bare command tag with no summary content classified but unsummarised', () => {
    // Act
    const info = classifySystemText('<command-args></command-args>');

    // Assert
    should(info?.label).equal('command');
    should(info?.summary).be.undefined();
  });

  test('should leave a human sentence that opens with an unlisted tag as a user message', () => {
    // Act
    const info = classifySystemText('<command it to stop> please');

    // Assert
    should(info).be.null();
  });
});

describe('classifySystemText — Codex protocol turn', () => {
  test('should classify the AGENTS.md instructions turn when the wrapper is present', () => {
    // Arrange
    const text = `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n- Run commands through direnv exec.\n</INSTRUCTIONS>`;

    // Act
    const info = classifySystemText(text);

    // Assert
    should(info?.label).equal('agents instructions');
    should(info?.summary).equal('Codex harness instructions');
    should(info?.raw).equal(text);
  });

  test('should leave the AGENTS.md heading without the wrapper as a user message', () => {
    // Act
    const info = classifySystemText('# AGENTS.md instructions\n\nI edited these by hand, take a look.');

    // Assert
    should(info).be.null();
  });

  test('should leave an ordinary Markdown heading as a user message', () => {
    // Act
    const info = classifySystemText('# Notes\n\nhere are some thoughts on the design');

    // Assert
    should(info).be.null();
  });
});

describe('classifySystemText — generic fallback', () => {
  test('should label an all-tag wrapper with its tag name and no summary', () => {
    // Act
    const info = classifySystemText(ENVIRONMENT_CONTEXT);

    // Assert
    should(info?.label).equal('environment_context');
    should(info?.summary).be.undefined();
    should(info?.raw).equal(ENVIRONMENT_CONTEXT);
  });

  test('should label an unknown wrapper with a matching close tag and summarise its prose', () => {
    // Act
    const info = classifySystemText('<future_wrapper>\nsome human-useful line\n</future_wrapper>');

    // Assert
    should(info?.label).equal('future_wrapper');
    should(info?.summary).equal('some human-useful line');
  });

  test('should classify a first-line tag that carries attributes', () => {
    // Act
    const info = classifySystemText('<wrapper id="x" type="note">\nbody text\n</wrapper>');

    // Assert
    should(info?.label).equal('wrapper');
  });
});

describe('classifySystemText — never demote a human message', () => {
  test('should leave an opening tag with no close tag as a user message', () => {
    // Act
    const info = classifySystemText('<thinking about this> what should I do here?');

    // Assert
    should(info).be.null();
  });

  test('should leave a message that merely starts with a bracket as a user message', () => {
    // Act
    const info = classifySystemText('<3 this is great, can you also add tests?');

    // Assert
    should(info).be.null();
  });

  test('should leave ordinary prose as a user message', () => {
    // Act
    const info = classifySystemText('hey can you restart this session? it seems stuck');

    // Assert
    should(info).be.null();
  });

  test('should leave empty text unclassified', () => {
    // Act
    const info = classifySystemText('');

    // Assert
    should(info).be.null();
  });

  test('should leave whitespace-only text unclassified', () => {
    // Act
    const info = classifySystemText('   \n  ');

    // Assert
    should(info).be.null();
  });
});
