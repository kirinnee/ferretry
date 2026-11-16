import { describe, it } from 'bun:test';
import should from 'should';
import { classifyCommand, classifyProcessArgv } from '../../../../daemon/lib/moves/command-classifier.ts';
import { verdictBlocksMove } from '../../../../daemon/lib/moves/verdict.ts';

/** Claude Code 2.1.317's Bash tool shell, character for character; only the payload and snapshot vary. */
const wrapper = (payload: string, tail = ' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd'): string =>
  "/usr/bin/zsh -c source /home/kirin/.ferretry/fleet/homes/6407bee8/shell-snapshots/snapshot-zsh-1763000000-ab12cd.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '" +
  payload +
  "'" +
  tail;

describe('a Claude Code tool shell is classified by the command inside it', () => {
  it('should read the payload, not the wrapper’s own redirects', () => {
    should(classifyProcessArgv(wrapper('ls -la'))).equal('safe_to_kill');
    should(classifyProcessArgv(wrapper('rg foo'))).equal('safe_to_kill');
    should(classifyProcessArgv(wrapper('git push'))).equal('destructive_to_interrupt');
    should(classifyProcessArgv(wrapper('bun test'))).equal('re_armable');
    should(classifyCommand(wrapper('ls -la'))).equal('safe_to_kill');
  });

  it('should keep the payload’s OWN redirects and expansions as strict as ever', () => {
    should(classifyProcessArgv(wrapper('cmd > out.txt'))).equal('unknown');
    should(classifyProcessArgv(wrapper('ls > out.txt'))).equal('unknown');
    should(classifyProcessArgv(wrapper('echo $(rm -rf x)'))).equal('unknown');
    should(classifyProcessArgv(wrapper('ls >| keep'))).equal('unknown');
  });

  it('should take the worst of a compound payload and un-quote an embedded quote', () => {
    should(classifyProcessArgv(wrapper('rg a && git push'))).equal('destructive_to_interrupt');
    should(classifyProcessArgv(wrapper(`rg '"'"'a b'"'"'`))).equal('safe_to_kill');
  });

  it('should classify a malformed or look-alike wrapper as the opaque shell it is', () => {
    const bad = [
      wrapper('ls', ' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd; rm -rf x'),
      wrapper('ls', ' < /dev/null && rm x && pwd -P >| /tmp/claude-99ff-cwd'),
      wrapper('ls', ' < /dev/null'),
      wrapper('ls').replace('source /home', 'source $(evil) /home'),
      wrapper('ls').replace("'which'; ", "'which'; rm x; "),
      wrapper("ls'; rm -rf /; echo '"),
      `timeout 5 ${wrapper('ls')}`,
      wrapper('ls').replace('/usr/bin/zsh', '/usr/bin/zsh -x'),
    ];
    // Whatever else it is, it must block: unknown (opaque) or destructive (the stray command is seen), never safe.
    for (const argv of bad) should(verdictBlocksMove(classifyProcessArgv(argv))).be.true();
  });
});

describe('a Codex tool shell', () => {
  it('should be classified by the command handed to bash -lc', () => {
    should(classifyProcessArgv('/bin/bash -lc rg x')).equal('safe_to_kill');
    should(classifyProcessArgv("bash -lc 'rg x'")).equal('safe_to_kill');
    should(classifyProcessArgv('/bin/bash -lc git push')).equal('destructive_to_interrupt');
    should(classifyProcessArgv('/bin/bash -lc bun test')).equal('re_armable');
    should(classifyProcessArgv('/bin/bash -lc rg x > out.txt')).equal('unknown');
  });
});

describe('fy verbs', () => {
  it('should treat reading and messaging verbs as safe', () => {
    for (const command of [
      'fy wait ses-1',
      'fy wait ses-1 --timeout 600 --keep',
      'fy status',
      'fy status --subtree',
      'fy ps -a',
      'fy send wren hello',
      'fy recommend',
      'fy task show F12',
      'fy task note F12 progress',
      'fy --as-owner status',
      '/home/kirin/.nix-profile/bin/fy logs ses-1',
    ])
      should(classifyCommand(command)).equal('safe_to_kill');
  });

  it('should leave every other verb unclassified', () => {
    for (const command of [
      'fy migrate wren --agent claude-llm3',
      'fy restart wren',
      'fy stop children me',
      'fy task move F12 done',
      'fy task',
      'fy',
      'fy daemon update',
      'fy --other status',
      'fy signal done x',
      'fy new --auto x',
    ])
      should(classifyCommand(command)).equal('unknown');
  });
});

describe('the safe tables', () => {
  it('should know this box’s grep and ls aliases', () => {
    should(classifyCommand('eza --icons auto --git -la')).equal('safe_to_kill');
    should(classifyCommand('ugrep -rn foo .')).equal('safe_to_kill');
    should(classifyCommand('ug foo')).equal('safe_to_kill');
    should(classifyCommand('bat file.ts')).equal('safe_to_kill');
    should(classifyCommand('fd -e ts')).equal('safe_to_kill');
    should(classifyCommand('rg foo')).equal('safe_to_kill');
  });

  it('should let a directly exec’d read-only process keep `|` in its arguments (the shell already ate the quotes)', () => {
    should(classifyProcessArgv('ugrep -E ✖|refused')).equal('safe_to_kill');
    should(classifyProcessArgv('grep -v \\[safe\\]')).equal('safe_to_kill');
    // …but only for the process table: command TEXT still parses its operators.
    should(classifyCommand('grep -E a|refused')).equal('unknown');
    should(classifyCommand('echo a | git commit -am x')).equal('destructive_to_interrupt');
    // A prefix or shell first word is not "exec'd directly".
    should(classifyProcessArgv('watch ls; rm x')).equal('destructive_to_interrupt');
    should(classifyProcessArgv('bash -c ls|rm x')).equal('destructive_to_interrupt');
  });

  it('should accept only redirects that touch no file', () => {
    should(classifyCommand('rg foo 2>&1')).equal('safe_to_kill');
    should(classifyCommand('rg foo 2>/dev/null')).equal('safe_to_kill');
    should(classifyCommand('rg foo > /dev/null 2>&1')).equal('safe_to_kill');
    should(classifyCommand('rg foo < /dev/null')).equal('safe_to_kill');
    should(classifyCommand('rg foo > /dev/nullx')).equal('unknown');
    should(classifyCommand('rg foo >/dev/null/../x')).equal('unknown');
    should(classifyCommand('rg foo > out.txt')).equal('unknown');
    should(classifyCommand('rg foo 2>&1 > out.txt')).equal('unknown');
  });
});
