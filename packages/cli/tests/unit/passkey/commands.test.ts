import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerPasskeyCommands } from '../../../src/lib/passkey/commands';
import { PasskeyController } from '../../../src/lib/passkey/controller';
import { FixedLocalTime, PIXEL, PIXEL_ID, RecordingOutput, ScriptedGateway } from './fixtures';

function run(argv: string[], binaryName = 'fy') {
  const gateway = new ScriptedGateway([PIXEL]);
  const out = new RecordingOutput();
  const program = new Command().name(binaryName).exitOverride();
  const printed: string[] = [];
  program.configureOutput({ writeOut: text => printed.push(text), writeErr: () => {} });
  registerPasskeyCommands(program, new PasskeyController({ gateway, out, time: new FixedLocalTime(), binaryName }));
  return { parsed: program.parseAsync(['node', binaryName, ...argv]), printed, gateway, out };
}

describe('passkey command surface', () => {
  it('should run the window verb against the device it was given', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['passkey', 'window', PIXEL_ID]);
    await parsed;

    // Assert
    should(gateway.opened).eql([PIXEL_ID]);
  });

  it('should explain why the verb exists, in the name of the binary it was given', async () => {
    // Arrange + Act
    const { parsed, printed } = run(['passkey', '--help'], 'foo');
    await should(parsed).be.rejected();

    // Assert
    const help = printed.join('');
    should(help).containEql('never "at the machine"');
    should(help).containEql("owner's verb");
    should(help).containEql('foo passkey window "Pixel 8"');
    should(help).containEql('no --json');
  });

  it('should demand a device', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['passkey', 'window']);

    // Assert
    await should(parsed).be.rejected();
    should(gateway.opened).eql([]);
  });
});
