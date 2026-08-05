import { describe, it } from 'bun:test';
import should from 'should';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim';
import { StateHomeController } from '../../../src/lib/state-home/controller';
import { CapturedOutput, directories, FakeStateHomeFiles, files } from './fixtures';

const HOME = '/tmp/fy-home/.ferretry';

function controller(entries?: readonly { name: string; directory: boolean }[], marker?: string) {
  const out = new CapturedOutput();
  const store = new FakeStateHomeFiles(entries, marker);
  return {
    out,
    store,
    controller: new StateHomeController(new StateHomeClaimService(store, 'fy daemon adopt'), HOME, out),
  };
}

describe('the adopt verb', () => {
  it('should show what it adopted, not merely that it adopted', async () => {
    // Arrange — the entire justification for adopting a provisioned home, where the daemon's silent
    // recovery refuses one, is that a person was shown what they were claiming.
    const { controller: adopt, out } = controller(directories('fleet', 'logs'));

    // Act
    await adopt.adopt({});

    // Assert
    should(out.text).containEql(`adopted ${HOME}`);
    should(out.text).containEql('fleet');
    should(out.text).containEql('logs');
  });

  it('should say plainly when a home needs nothing done to it', async () => {
    // Arrange
    const { controller: adopt, out } = controller([...directories('fleet'), ...files('layout-version')], '1\n');

    // Act
    await adopt.adopt({});

    // Assert
    should(out.text).containEql('already a claimed Ferretry state home');
  });

  it('should report an empty home as empty rather than printing a blank list', async () => {
    // Arrange
    const { controller: adopt, out } = controller([]);

    // Act
    await adopt.adopt({});

    // Assert
    should(out.text).containEql('(empty)');
  });

  it('should explain that an absent home is not an error', async () => {
    // Arrange — a person who typed the wrong FY_HOME needs to know nothing was created for them.
    const { controller: adopt, out } = controller(undefined);

    // Act
    await adopt.adopt({});

    // Assert
    should(out.text).containEql('nothing to adopt');
  });

  it('should print a machine shape behind --json, like its siblings', async () => {
    // Arrange
    const { controller: adopt, out } = controller(directories('fleet'));

    // Act
    await adopt.adopt({ json: true });

    // Assert — a script branches on `outcome` without parsing the sentence.
    const payload = JSON.parse(out.text) as { outcome?: string; entries?: string[] };
    should(payload.outcome).equal('adopted');
    should(payload.entries).deepEqual(['fleet']);
  });

  it('should give --json an empty entry list for an absent home rather than omitting the key', async () => {
    // Arrange — a caller destructuring `entries` must not have to guard the one case that has none.
    const { controller: adopt, out } = controller(undefined);

    // Act
    await adopt.adopt({ json: true });

    // Assert
    should(JSON.parse(out.text)).deepEqual({ outcome: 'absent', home: HOME, entries: [] });
  });

  it('should let a refusal reach the composition root rather than reporting success', async () => {
    // Arrange
    const { controller: adopt, out } = controller(files('thesis.tex'));

    // Act + Assert
    await should(adopt.adopt({})).be.rejectedWith(/thesis\.tex/u);
    should(out.lines).be.empty();
  });
});
