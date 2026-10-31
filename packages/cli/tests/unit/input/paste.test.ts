import { describe, it } from 'bun:test';
import should from 'should';
import { InputController } from '../../../src/lib/input/controller';
import { renderInputFacts } from '../../../src/lib/input/render';
import { FakeInputGateway, request, rig, SESSION } from './fixtures';

const PASTE = request({ source: { kind: 'sealed', name: 'vercel', from: { kind: 'command', program: 'gh' } } });

describe('fy input answer on a paste', () => {
  it('should allow the paste without reading a value, even from a pipe', async () => {
    // Arrange
    const { ports, gateway, out, prompt } = rig({ interactive: false }, new FakeInputGateway([PASTE]));

    // Act
    await new InputController(ports).answer('!A7', { session: SESSION });

    // Assert
    should(prompt.asked).eql([]);
    should(gateway.delivered.map(sent => sent.body)).match([{ sealed: true, submit: true }]);
    should(gateway.delivered[0]?.body.padded).be.undefined();
    should(out.diagnostics).containEql('allowing the paste of sealed:vercel');
    should(out.messages).eql(['Pasted into %terminal:dev and pressed Enter.']);
  });

  it('should refuse a saved login or a save on a paste, sending nothing', async () => {
    // Arrange
    const { ports, gateway } = rig({}, new FakeInputGateway([PASTE]));
    const controller = new InputController(ports);

    // Act
    const named = await controller.answer('!A7', { session: SESSION, secret: 'SUDO_BOX' }).then(
      () => undefined,
      (error: Error) => error.message,
    );
    const saving = await controller.answer('!A7', { session: SESSION, saveAs: 'SUDO_BOX' }).then(
      () => undefined,
      (error: Error) => error.message,
    );

    // Assert
    should(named).equal('!A7 pastes a secure copy: there is nothing to type, choose or save');
    should(saving).equal(named);
    should(gateway.delivered).eql([]);
  });

  it('should say what is pasted and where it came from', () => {
    should(renderInputFacts(PASTE)).containEql(
      'pastes the secure copy sealed:vercel, captured from gh: nothing to type',
    );
  });

  it('should name the file that printed it when the daemon found one', () => {
    const located = {
      ...PASTE,
      source: {
        kind: 'sealed',
        name: 'vercel',
        from: { kind: 'command', program: 'gh', path: '/home/k/.local/bin/gh' },
      },
    } as typeof PASTE;

    should(renderInputFacts(located)).containEql(
      'pastes the secure copy sealed:vercel, captured from /home/k/.local/bin/gh: nothing to type',
    );
  });
});
