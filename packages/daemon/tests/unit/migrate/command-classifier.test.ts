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

  it('should classify harness tools conservatively by name', () => {
    // Act + Assert
    should(classifyToolName('Read')).equal('safe_to_kill');
    should(classifyToolName('Edit')).equal('re_armable');
    should(classifyToolName('Bash')).equal('unknown');
  });
});
