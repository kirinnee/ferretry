import { describe, it } from 'bun:test';
import should from 'should';
import { classifyCommand, classifyProcessArgv } from '../../../../daemon/lib/moves/command-classifier.ts';
import { fySendHoldingFlags, fySendVerb, safeFyVerbLines } from '../../../../daemon/lib/moves/command-tables.ts';
import { verdictBlocksMove } from '../../../../daemon/lib/moves/verdict.ts';
import { join } from 'node:path';

/** Claude Code 2.1.317's Bash tool shell, character for character; only the payload and snapshot vary. */
const wrapper = (payload: string, tail = ' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd'): string =>
  "/usr/bin/zsh -c source /home/kirin/.ferretry/fleet/homes/6407bee8/shell-snapshots/snapshot-zsh-1763000000-ab12cd.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '" +
  payload +
  "'" +
  tail;

/** Every manifest's `verb('<line>')` declarations, read from the workspace's own manifests rather than copied here. */
const declaredSendFlags = new Set<string>();
async function declaredVerbLines(): Promise<ReadonlySet<string>> {
  const packages = join(import.meta.dir, '../../../../../..');
  const lines = new Set<string>();
  for (const pattern of ['core/*/manifest.ts', 'plugins/*/manifest.ts']) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: packages, absolute: true })) {
      const manifest = (await import(file)).default as {
        readonly actions?: {
          readonly cli?: readonly { readonly verb: string; readonly options?: readonly { readonly flag: string }[] }[];
        };
      };
      for (const declaration of manifest.actions?.cli ?? []) {
        // `status [id]`, `wait <id>`, `guide accept <run>`: the words before the first argument placeholder.
        lines.add(declaration.verb.split(/\s+[<[]/u)[0] ?? declaration.verb);
        if (declaration.verb === 'send')
          for (const option of declaration.options ?? [])
            for (const flag of option.flag.split(/,\s*/u)) declaredSendFlags.add(flag.split(' ')[0] ?? flag);
      }
    }
  }
  return lines;
}

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
  it('should treat reading verbs as safe', () => {
    for (const command of [
      'fy wait ses-1',
      'fy wait ses-1 --timeout 600 --keep',
      'fy status',
      'fy status --subtree',
      'fy ps -a',
      'fy recommend',
      'fy search hello',
      'fy logs ses-1',
      'fy guide',
      'fy guide --json',
      'fy guide show',
      'fy guide show --json',
      'fy guide inventory',
      'fy card show F12',
      'fy card show F12 --yaml',
      'fy card note F12 progress',
      'fy --as-owner status',
      '/home/kirin/.nix-profile/bin/fy logs ses-1',
    ])
      should(classifyCommand(command)).equal('safe_to_kill');
  });

  it('should NOT treat a guide verb that writes or starts a model run as safe', () => {
    for (const command of [
      'fy guide accept run-1',
      'fy guide undo',
      'fy guide clean-up',
      'fy guide write --idea x',
      'fy guide frobnicate',
      'fy guide --json accept run-1',
    ])
      should(verdictBlocksMove(classifyCommand(command))).be.true();
  });

  it('should make send re-armable, and refuse the flags that interrupt, park or wait', () => {
    should(classifyCommand('fy send wren hello')).equal('re_armable');
    should(classifyCommand('fy send wren hello --kind fyi --json')).equal('re_armable');
    should(classifyCommand('fy send wren hello --expect-reply')).equal('re_armable');
    for (const flags of ['--now', '--ask', '--wait', '--ask --until 2h', '--kind blocker --now'])
      should(classifyCommand(`fy send wren hello ${flags}`)).equal('unknown');
  });

  it('should leave every other verb, and every other card verb, unclassified', () => {
    for (const command of [
      'fy migrate wren --agent claude-llm3',
      'fy restart wren',
      'fy stop children me',
      'fy card move F12 done',
      'fy card',
      'fy card --json',
      'fy task show F12',
      'fy',
      'fy daemon update',
      'fy --other status',
      'fy signal done x',
      'fy new --auto x',
      'fy snapshot',
      'fy events',
      'fy view',
    ])
      should(classifyCommand(command)).equal('unknown');
  });

  it('should list only verbs the manifests declare', async () => {
    // Arrange — every verb line any plugin or core manifest declares, as `verb('…')` spells it.
    const declared = await declaredVerbLines();

    // Act + Assert — a safe verb the CLI does not have (the list once held `snapshot`, `events` and `view`) fails here.
    should(declared.size).be.above(100);
    for (const line of safeFyVerbLines) should(declared.has(line)).be.true();
    should(declared.has('send')).be.true();
    should(declared.has(fySendVerb)).be.true();
    for (const flag of fySendHoldingFlags) should(declaredSendFlags.has(flag)).be.true();
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

describe('a multi-line tool command is judged line by line', () => {
  const MULTI_LINE = 'echo start\ngit stash\nbun test\ngit stash pop';
  /** What `ps` and the display copy print: every control character, a newline included, is a `?`. */
  const lossy = (text: string): string => text.replaceAll('\n', '?');

  it('should see the stash in the middle when the kernel’s exact words are read', () => {
    should(classifyProcessArgv(wrapper(MULTI_LINE), 'exact')).equal('destructive_to_interrupt');
    should(classifyProcessArgv(wrapper('echo a\nls -la\nrg x'), 'exact')).equal('safe_to_kill');
    should(classifyProcessArgv(wrapper('echo a\nbun test'), 'exact')).equal('re_armable');
    should(classifyCommand(wrapper(MULTI_LINE))).equal('destructive_to_interrupt');
  });

  it('should NOT unwrap the lossy form — `echo start` alone would be safe_to_kill and hide the rest', () => {
    // The adapter’s real `ps` form, and the default when a caller does not say the text is exact.
    should(classifyProcessArgv(lossy(wrapper(MULTI_LINE)), 'lossy')).equal('unknown');
    should(classifyProcessArgv(lossy(wrapper(MULTI_LINE)))).equal('unknown');
    should(verdictBlocksMove(classifyProcessArgv(lossy(wrapper('echo start\nrm -rf x'))))).be.true();
    should(classifyCommand(lossy(wrapper(MULTI_LINE)), 'lossy')).equal('unknown');
  });

  it('should still unwrap a lossy payload that has no `?` in it', () => {
    should(classifyProcessArgv(wrapper('rg foo'), 'lossy')).equal('safe_to_kill');
    should(classifyProcessArgv(wrapper('bun test'), 'lossy')).equal('re_armable');
  });

  it('should read a real `?` in an exact payload as the glob it is', () => {
    should(classifyProcessArgv(wrapper('ls file?.txt'), 'exact')).equal('safe_to_kill');
    should(classifyProcessArgv(wrapper('ls file?.txt'), 'lossy')).equal('unknown');
  });

  it('should apply the same rule to a Codex `bash -lc` program and a find -exec payload', () => {
    should(classifyProcessArgv('/bin/bash -lc echo start\ngit stash', 'exact')).equal('destructive_to_interrupt');
    should(classifyProcessArgv('/bin/bash -lc echo start?git stash', 'lossy')).equal('unknown');
    should(classifyCommand('find . -exec sh -c ls?x {} ;', 'lossy')).equal('unknown');
  });
});

describe('read-only programs that write or run something through one option', () => {
  const blocks = (command: string) => should(verdictBlocksMove(classifyCommand(command))).be.true();
  const safe = (command: string) => should(classifyCommand(command)).equal('safe_to_kill');

  it('should refuse yq -i / --inplace / -s and keep a plain read safe', () => {
    for (const command of [
      'yq -i .a=1 f.yml',
      'yq eval -i .a=1 f.yml',
      'yq -ri .a=1 f.yml',
      'yq --inplace .a f.yml',
      'yq -s .a f.yml',
    ])
      blocks(command);
    safe('yq .a f.yml');
    safe('yq eval .a.b f.yml -o json');
  });

  it('should refuse sort -o / --output and keep a plain sort safe', () => {
    for (const command of [
      'sort -o out in',
      'sort -o out in',
      'sort -nro out in',
      'sort -oout in',
      'sort --output=out in',
      'sort --output out in',
    ])
      blocks(command);
    safe('sort -n in');
    safe('sort -t: -k2,2 in');
    safe('sort --reverse in');
  });

  it('should refuse tree -o and keep a listing safe', () => {
    blocks('tree -o listing.txt');
    blocks('tree -L 2 -ofile');
    safe('tree -L 2 src');
    safe('tree --noreport src');
  });

  it('should refuse uniq <in> <out> and keep one operand safe', () => {
    blocks('uniq in out');
    blocks('uniq -c in out');
    safe('uniq');
    safe('uniq in');
    safe('uniq -c in');
    safe('uniq -f 1 in');
  });

  it('should classify what fd -x / -X / --exec / --exec-batch runs, as find -exec does', () => {
    for (const command of [
      'fd -x rm {}',
      'fd -e tmp -X rm',
      'fd --exec rm {}',
      'fd --exec-batch git stash',
      'fd -HIx rm {}',
    ])
      blocks(command);
    safe('fd -x ls {}');
    safe('fd -X wc -l');
    safe('fd -e ts');
    safe('fd -t x src');
    should(classifyCommand('fd -x')).equal('unknown');
  });

  it('should refuse ugrep --save-config and --filter, and rg --pre', () => {
    for (const command of [
      'ugrep --save-config foo',
      'ug --save-config=cfg foo',
      'ugrep --filter=pdf:pdftotext foo',
      'ug --save-config',
    ])
      blocks(command);
    should(classifyCommand('rg --pre ./prep foo')).equal('unknown');
    should(classifyCommand('rg --pre=./prep foo')).equal('unknown');
    safe('ugrep -rn foo .');
    safe('rg -n foo');
    safe('rg --pre-glob "*.pdf" foo');
  });

  it('should apply the same arguments to a process exec’d directly, and to a tool shell wrapping them', () => {
    for (const argv of [
      'sort -o out in',
      'yq -i .a=1 f.yml',
      'tree -o x',
      'uniq in out',
      'fd -x rm',
      'ugrep --save-config',
    ])
      should(verdictBlocksMove(classifyProcessArgv(argv, 'exact'))).be.true();
    for (const argv of ['sort -o out in', 'yq -i .a=1 f.yml', 'uniq in out', 'fd -x rm'])
      should(verdictBlocksMove(classifyProcessArgv(wrapper(argv), 'exact'))).be.true();
    should(classifyProcessArgv('sort -n in', 'exact')).equal('safe_to_kill');
    should(classifyProcessArgv('fd -x ls', 'exact')).equal('safe_to_kill');
  });
});
