import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerBrowserCommands } from '../../../src/lib/browser/command';
import type { IBrowserRunner } from '../../../src/lib/browser/controller';
import { registerFirewallCommands } from '../../../src/lib/browser/firewall';

const FILES = {
  script: '#!/usr/bin/env bash\necho hi\n',
  unit: '[Unit]\nDescription=x\n',
  verifyUnit: '[Unit]\nDescription=v\n',
  timer: '[Timer]\nOnBootSec=1min\n',
};

function harness(prepare: (program: Command) => void = () => {}) {
  const lines: string[] = [];
  const runner: IBrowserRunner = { run: async () => 0 };
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerBrowserCommands(program, runner);
  prepare(program);
  registerFirewallCommands(program, FILES, { report: line => lines.push(line) });
  const run = (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]);
  return { lines, run, program };
}

describe('fy browser firewall', () => {
  it('should print the script so that stdout is exactly the file once the output adds its own newline', async () => {
    // Arrange
    const { lines, run } = harness();

    // Act
    await run('browser', 'firewall', 'script');

    // Assert
    should(lines.map(line => `${line}\n`)).deepEqual([FILES.script]);
  });

  it.each([
    ['verify-unit', FILES.verifyUnit],
    ['timer', FILES.timer],
  ])('should print the %s the same way', async (verb, file) => {
    // Arrange
    const { lines, run } = harness();

    // Act
    await run('browser', 'firewall', verb);

    // Assert
    should(lines.map(line => `${line}\n`)).deepEqual([file]);
  });

  it('should print the unit the same way', async () => {
    // Arrange
    const { lines, run } = harness();

    // Act
    await run('browser', 'firewall', 'unit');

    // Assert
    should(lines.map(line => `${line}\n`)).deepEqual([FILES.unit]);
  });

  it('should pass a file with no final newline through untouched', async () => {
    // Arrange
    const lines: string[] = [];
    const program = new Command().exitOverride();
    registerBrowserCommands(program, { run: async () => 0 });
    registerFirewallCommands(program, { ...FILES, script: 'no newline' }, { report: line => lines.push(line) });

    // Act
    await program.parseAsync(['node', 'fy', 'browser', 'firewall', 'script']);

    // Assert
    should(lines).deepEqual(['no newline']);
  });

  it('should share one firewall group with the entry verb instead of adding a second', async () => {
    // Arrange
    const { program, run, lines } = harness();

    // Act
    await run('browser', 'firewall', 'unit');

    // Assert
    const browser = program.commands.find(command => command.name() === 'browser') as Command;
    const groups = browser.commands.filter(command => command.name() === 'firewall');
    should(groups).have.length(1);
    should((groups[0] as Command).commands.map(command => command.name()).sort()).deepEqual([
      'entry',
      'script',
      'timer',
      'unit',
      'verify-unit',
    ]);
    should(lines).deepEqual(['[Unit]\nDescription=x']);
  });

  it('should refuse to register before the browser group exists', () => {
    // Arrange
    const program = new Command();

    // Act
    const register = () => registerFirewallCommands(program, FILES, { report: () => {} });

    // Assert
    should(register).throw('the browser command group must be registered before its firewall verbs');
  });
});
