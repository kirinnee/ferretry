import { describe, it } from 'bun:test';
import should from 'should';
import { classifyCommand, classifyToolName } from '../../../src/lib/migrate/command-classifier.ts';

describe('migration command classifier', () => {
  it('should classify known read-only, repeatable, and mutating commands', () => {
    // Act + Assert
    for (const command of ['rg pattern', 'git status', 'curl https://example.test', 'sudo ls -la'])
      should(classifyCommand(command)).equal('safe_to_kill');
    for (const command of ['tsc --noEmit', 'npm test', 'bun run build', 'timeout 60 vitest run'])
      should(classifyCommand(command)).equal('re_armable');
    for (const command of ['git push', 'npm install', 'terraform apply', 'curl -X POST https://example.test'])
      should(classifyCommand(command)).equal('destructive_to_interrupt');
  });

  it('should take the worst segment of a compound command', () => {
    // Act + Assert
    should(classifyCommand('rg TODO && npm test')).equal('re_armable');
    should(classifyCommand('echo done | git commit -am work')).equal('destructive_to_interrupt');
  });

  it('should fail closed for malformed, unrecognised, or shell-expanded commands', () => {
    // Act + Assert
    for (const command of [
      '',
      'timeout',
      'npm --silent',
      "'npm'",
      'npm run mystery',
      'unknown-tool --go',
      'echo $(rm -rf /tmp/x)',
      'printf x > file',
    ])
      should(classifyCommand(command)).equal('unknown');
  });

  it('should classify package scripts by their declared intent', () => {
    // Act + Assert
    should(classifyCommand('pnpm run lint')).equal('re_armable');
    should(classifyCommand('yarn run deploy')).equal('destructive_to_interrupt');
    should(classifyCommand('bun run')).equal('unknown');
    should(classifyCommand('git -C repository status')).equal('safe_to_kill');
    should(classifyCommand('git')).equal('safe_to_kill');
  });

  it('should classify a stream editor by whether it rewrites in place', () => {
    // Act + Assert
    should(classifyCommand('sed -n 2p src/app.ts')).equal('safe_to_kill');
    should(classifyCommand('awk -F: {print}')).equal('safe_to_kill');
    should(classifyCommand("sed -i 's/a/b/g' src/app.ts")).equal('destructive_to_interrupt');
    should(classifyCommand("sed -i.bak 's/a/b/g' src/app.ts")).equal('destructive_to_interrupt');
    should(classifyCommand('awk -i inplace {print} src/app.ts')).equal('destructive_to_interrupt');
  });

  it('should refuse to read a shell script it cannot see the contents of', () => {
    // Act + Assert — a bare interpreter is the pane's idle login shell.
    should(classifyCommand('bash')).equal('safe_to_kill');
    should(classifyCommand('zsh -l')).equal('safe_to_kill');
    // Whereas a script operand hides everything the script does.
    should(classifyCommand('bash /home/agent/deploy.sh')).equal('unknown');
    should(classifyCommand('sh -c rm-everything.sh')).equal('unknown');
    should(classifyCommand('zsh ./release.sh')).equal('unknown');
  });

  it('should classify the program a shell was handed with -c', () => {
    // Act + Assert
    should(classifyCommand("bash -c 'rg TODO'")).equal('safe_to_kill');
    should(classifyCommand("bash -c 'npm test'")).equal('re_armable');
    should(classifyCommand("sh -c 'rm -rf /tmp/work'")).equal('destructive_to_interrupt');
    should(classifyCommand('dash -c')).equal('unknown');
  });

  it('should classify find by the action it performs, not by its name', () => {
    // Act + Assert
    should(classifyCommand('find . -name node_modules')).equal('safe_to_kill');
    should(classifyCommand('find . -name node_modules -delete')).equal('destructive_to_interrupt');
    should(classifyCommand('find . -name "*.log" -exec rm {} \\;')).equal('destructive_to_interrupt');
    should(classifyCommand('find . -type f -exec grep -l TODO {} +')).equal('safe_to_kill');
    should(classifyCommand('find . -exec')).equal('unknown');
  });

  it('should classify tmux by its subcommand rather than trusting the binary', () => {
    // Act + Assert
    should(classifyCommand('tmux')).equal('safe_to_kill');
    should(classifyCommand('tmux display-message -p pane')).equal('safe_to_kill');
    should(classifyCommand('tmux -S /run/fy.sock has-session -t work')).equal('safe_to_kill');
    should(classifyCommand('tmux kill-server')).equal('destructive_to_interrupt');
    should(classifyCommand('tmux -S /run/fy.sock kill-session -t work')).equal('destructive_to_interrupt');
    should(classifyCommand('tmux -2 send-keys -t work C-c')).equal('destructive_to_interrupt');
  });

  it('should treat writing a git config value as destructive and reading one as safe', () => {
    // Act + Assert
    should(classifyCommand('git config --global user.email hijack@example.test')).equal('destructive_to_interrupt');
    should(classifyCommand('git config --unset user.email')).equal('destructive_to_interrupt');
    should(classifyCommand('git config user.email')).equal('safe_to_kill');
    should(classifyCommand('git config --list')).equal('safe_to_kill');
    should(classifyCommand('git -c core.pager=cat config --get user.email')).equal('safe_to_kill');
  });

  it('should classify harness tools conservatively by name', () => {
    // Act + Assert
    should(classifyToolName('Read')).equal('safe_to_kill');
    should(classifyToolName('Edit')).equal('re_armable');
    should(classifyToolName('Bash')).equal('unknown');
  });
});
