import { describe, it } from 'bun:test';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import should from 'should';
import { PasskeyController } from '../../../src/lib/passkey/controller';
import {
  CLOSES_AT,
  device,
  FixedLocalTime,
  LAPTOP,
  OTHER_LAPTOP,
  PIXEL,
  PIXEL_ID,
  RecordingOutput,
  ScriptedGateway,
} from './fixtures';

function subject(gateway: ScriptedGateway) {
  const out = new RecordingOutput();
  const time = new FixedLocalTime();
  return { out, time, controller: new PasskeyController({ gateway, out, time, binaryName: 'fy' }) };
}

describe('fy passkey window', () => {
  it('should open the window for a device named by id and say when it closes', async () => {
    // Arrange
    const gateway = new ScriptedGateway([PIXEL, LAPTOP]);
    const { out, time, controller } = subject(gateway);

    // Act
    await controller.window(PIXEL_ID);

    // Assert
    should(gateway.opened).eql([PIXEL_ID]);
    should(time.asked).eql([CLOSES_AT]);
    should(out.messages).eql([
      'The passkey window for Pixel 8 is open until 14:32. On that device, open Settings → Security → Add a passkey within 10 minutes.',
    ]);
    should(out.errors).eql([]);
    should(out.exitCode).equal(undefined);
  });

  it('should open the window for a device named by its unique name', async () => {
    // Arrange
    const gateway = new ScriptedGateway([PIXEL, LAPTOP]);
    const { out, controller } = subject(gateway);

    // Act
    await controller.window('Chrome');

    // Assert
    should(gateway.opened).eql([LAPTOP.id]);
    should(out.messages[0]).startWith('The passkey window for Chrome is open until 14:32.');
  });

  it('should name the matching devices and open nothing when a name is ambiguous', async () => {
    // Arrange
    const gateway = new ScriptedGateway([LAPTOP, OTHER_LAPTOP]);
    const { out, controller } = subject(gateway);

    // Act
    await controller.window('Chrome');

    // Assert
    should(gateway.opened).eql([]);
    should(out.errors).eql([
      `More than one paired device is named "Chrome", so pass the device id instead of the name: ${LAPTOP.id}, ${OTHER_LAPTOP.id}.`,
    ]);
    should(out.exitCode).equal(1);
  });

  it('should list the paired devices when the name is unknown', async () => {
    // Arrange
    const gateway = new ScriptedGateway([PIXEL, LAPTOP]);
    const { out, controller } = subject(gateway);

    // Act
    await controller.window('Tablet');

    // Assert
    should(gateway.opened).eql([]);
    should(out.errors).eql([
      'No paired device is named or numbered "Tablet". The paired devices are "Pixel 8", "Chrome".',
    ]);
    should(out.exitCode).equal(1);
  });

  it('should send the owner to pairing when no device is paired at all', async () => {
    // Arrange
    const { out, controller } = subject(new ScriptedGateway([]));

    // Act
    await controller.window('Tablet');

    // Assert
    should(out.errors).eql([
      'No paired device is named or numbered "Tablet", and no device is paired with this machine yet — run `fy pair` first.',
    ]);
    should(out.exitCode).equal(1);
  });

  it('should say only the owner at the machine may do this when the daemon refuses with 403', async () => {
    // Arrange
    const refused = new FyHttpError('only the owner …', 403, 'step_up_not_at_machine');
    const { out, controller } = subject(new ScriptedGateway([PIXEL], refused));

    // Act
    await controller.window('Pixel 8');

    // Assert
    should(out.errors).eql([
      'Only the owner at the machine can open a passkey window: run this on the host that runs the daemon, as the user whose admin token it holds, not against a remote daemon.',
    ]);
    should(out.messages).eql([]);
    should(out.exitCode).equal(1);
  });

  it('should say the device may have been revoked when the daemon answers 404 for it', async () => {
    // Arrange
    const gone = new FyHttpError('no paired device has that id', 404, 'step_up_unknown_device');
    const { out, controller } = subject(new ScriptedGateway([PIXEL], gone));

    // Act
    await controller.window('Pixel 8');

    // Assert
    should(out.errors).eql([
      'The daemon no longer knows that device, so it may have just been revoked — run `fy pair` to pair it again.',
    ]);
    should(out.exitCode).equal(1);
  });

  it('should say how to start the daemon when it cannot be reached', async () => {
    // Arrange
    const down = new FyTransportError('could not reach fyd', '/v1/pair/devices', false, new Error('ECONNREFUSED'));
    const { out, controller } = subject(new ScriptedGateway([PIXEL], down));

    // Act
    await controller.window('Pixel 8');

    // Assert
    should(out.errors).eql([
      'The daemon did not answer, so no window was opened — start it with `fy daemon start` and run this again.',
    ]);
    should(out.exitCode).equal(1);
  });

  it('should not flatten a failure it does not recognise into a confident sentence', async () => {
    // Arrange — another 403 (a governed grant refusal) is NOT "not at the machine".
    const other = new FyHttpError('step-up required', 403, 'grant_step_up_required');
    const { out, controller } = subject(new ScriptedGateway([PIXEL], other));

    // Act + Assert
    await should(controller.window('Pixel 8')).be.rejectedWith('step-up required');
    should(out.errors).eql([]);
    should(out.exitCode).equal(undefined);
  });

  it('should rethrow something that is not an HTTP error at all', async () => {
    // Arrange
    const { controller } = subject(new ScriptedGateway([PIXEL], new Error('boom')));

    // Act + Assert
    await should(controller.window('Pixel 8')).be.rejectedWith('boom');
  });

  it('should print a device name without the control characters a hostile device put in it', async () => {
    // Arrange
    const hostile = device(PIXEL_ID, 'Pixel\u001b[31m 8');
    const { out, controller } = subject(new ScriptedGateway([hostile]));

    // Act
    await controller.window(PIXEL_ID);

    // Assert
    should(out.messages[0]).startWith('The passkey window for Pixel[31m 8 is open');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is that no escape reaches the terminal.
    should(out.messages[0]).not.match(/\u001b/u);
  });
});
