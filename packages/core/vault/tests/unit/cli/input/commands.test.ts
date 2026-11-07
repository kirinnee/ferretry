import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerInputCommands } from '../../../src/lib/input/commands';
import { InputController } from '../../../src/lib/input/controller';
import { rig, SESSION, VALUE } from './fixtures';

function run(argv: string[], overrides = {}) {
  const harness = rig(overrides);
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerInputCommands(program, new InputController(harness.ports));
  return { ...harness, parsed: program.parseAsync(['node', 'fy', ...argv]) };
}

describe('fy input commands', () => {
  it('should answer with the owner’s typed value and no value anywhere on the command line', async () => {
    // Arrange
    const { parsed, gateway, out } = run(['input', 'answer', '!A7', '--session', SESSION]);

    // Act
    await parsed;

    // Assert
    should(gateway.delivered).have.length(1);
    should(out.all()).not.containEql(VALUE);
  });

  it('should refuse to take a value as a flag or argument', async () => {
    // Arrange
    const withFlag = run(['input', 'answer', '!A7', '--session', SESSION, '--value', VALUE]);
    const withArgument = run(['input', 'answer', '!A7', VALUE, '--session', SESSION]);

    // Act
    const flag = await withFlag.parsed.catch((error: unknown) => error);
    const argument = await withArgument.parsed.catch((error: unknown) => error);

    // Assert
    should(flag).be.an.Error();
    should(argument).be.an.Error();
    should(withFlag.gateway.delivered).have.length(0);
    should(withArgument.gateway.delivered).have.length(0);
  });

  it('should honour --no-enter', async () => {
    // Arrange
    const { parsed, gateway } = run(['input', 'answer', '!A7', '-s', SESSION, '--no-enter']);

    // Act
    await parsed;

    // Assert
    should(gateway.delivered[0]?.body.submit).equal(false);
  });

  it('should list and cancel', async () => {
    // Arrange
    const listed = run(['input', 'ls', '-s', SESSION]);
    const cancelled = run(['input', 'cancel', '!A7', '-s', SESSION]);

    // Act
    await listed.parsed;
    await cancelled.parsed;

    // Assert
    should(listed.out.messages[0]).containEql('!A7');
    should(cancelled.gateway.cancelled).have.length(1);
  });

  it('should refuse the whole group inside a ferret', async () => {
    // Arrange
    const { parsed, gateway } = run(['input', 'ls', '-s', SESSION], { ownSessionId: 'ferret-1' });

    // Act
    const failure = await parsed.catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql("a ferret's pane can't run it");
    should(gateway.listed).have.length(0);
  });
});
