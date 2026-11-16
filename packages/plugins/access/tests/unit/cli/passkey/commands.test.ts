import { describe, it } from 'bun:test';
import should from 'should';
import manifest from '../../../../manifest.ts';
import { overview, passkeyHelp, passkeyVerbs } from '../../../../cli/lib/passkey/commands.ts';
import { PasskeyController } from '../../../../cli/lib/passkey/controller.ts';
import { ExitStatus } from '../../../../cli/shell.ts';
import { FixedLocalTime, PIXEL, PIXEL_ID, RecordingOutput, ScriptedGateway } from './fixtures';

function run(verb: 'passkey' | 'passkey window', args: string[], binaryName = 'fy') {
  const gateway = new ScriptedGateway([PIXEL]);
  const out = new RecordingOutput();
  const exit = new ExitStatus();
  const errors: string[] = [];
  const verbs = passkeyVerbs(
    () => new PasskeyController({ gateway, out, time: new FixedLocalTime(), binaryName }),
    { err: text => errors.push(text) },
    exit,
    binaryName,
  );
  return { code: verbs[verb]({ args, options: {} }), errors, gateway, out };
}

describe('passkey command surface', () => {
  it('should implement both verbs the manifest declares', () => {
    const declared = (manifest.actions.cli as readonly { readonly verb: string }[]).map(entry => entry.verb);
    should(declared).containEql('passkey');
    should(declared).containEql('passkey window');
  });

  it('should run the window verb against the device it was given', async () => {
    // Arrange + Act
    const { code, gateway } = run('passkey window', [PIXEL_ID]);

    // Assert
    should(await code).equal(0);
    should(gateway.opened).eql([PIXEL_ID]);
  });

  it('should explain why the verb exists, in the name of the binary it was given', () => {
    // Arrange + Act
    const help = passkeyHelp('foo');

    // Assert
    should(help).containEql('never "at the machine"');
    should(help).containEql("owner's verb");
    should(help).containEql('foo passkey window "Pixel 8"');
    should(help).containEql('no --json');
    should(help).containEql(overview('foo'));
  });

  it('should answer the bare group with its help on stderr and exit 1, as commander did', async () => {
    // Arrange + Act
    const { code, errors, gateway } = run('passkey', [], 'foo');

    // Assert
    should(await code).equal(1);
    should(errors.join('')).containEql('foo passkey window "Pixel 8"');
    should(gateway.opened).eql([]);
  });

  it('should demand a device', async () => {
    // Arrange + Act
    const { code, errors, gateway } = run('passkey window', []);

    // Assert
    should(await code).equal(1);
    should(errors).eql(["error: missing required argument 'device'\n"]);
    should(gateway.opened).eql([]);
  });
});
