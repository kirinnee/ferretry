import { beforeEach, describe, it } from 'bun:test';
import should from 'should';
import { SECRET_TYPING_GAP } from '../../../cli/lib/verbs/typed-text.ts';
import { cliWorld, FakeDaemon, type Recorded, toolText } from '../../support/cli.ts';

/** A password no real one looks like, so a hit anywhere is this test's own. */
const SENTINEL = 'sentinel-Pa55w0rd-7f3a9c';
const TOOLS = 'POST /v1/ferrets/:ferretId/surfaces/browser/tools';

let daemon: FakeDaemon;
beforeEach(() => {
  daemon = new FakeDaemon();
});

const typedInput = (): unknown => {
  const call = daemon.calls[0] as Recorded;
  return call.via === 'tool' ? call.input : (call.init?.body as unknown);
};

describe('typing text into a page (v4 parity: the words stay)', () => {
  it('should type the words after the target, joined', async () => {
    // Arrange
    daemon.answer('browser_type', toolText('Done on %browser:app.'));
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#q', 'hello', 'there']);

    // Assert
    should(code).equal(0);
    should(typedInput()).deepEqual({ name: 'app', selector: '#q', text: 'hello there' });
  });
});

describe('typing sensitive text: --stdin', () => {
  it('should read the text from standard input, drop one trailing newline, and never print it back', async () => {
    // Arrange
    daemon.answer('browser_type', toolText('Done on %browser:app.'));
    const world = cliWorld(daemon, { stdin: `${SENTINEL}\n` });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#pw', '--stdin', '--submit']);

    // Assert
    should(code).equal(0);
    should(typedInput()).deepEqual({ name: 'app', selector: '#pw', text: SENTINEL, submit: true });
    should(world.stdout() + world.stderr()).not.containEql(SENTINEL);
  });

  it('should not repeat the text even when the daemon’s own answer does', async () => {
    // Arrange
    daemon.answer('browser_type', toolText(`The field showed "${SENTINEL}" after typing.`));
    const world = cliWorld(daemon, { stdin: SENTINEL });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#pw', '--stdin', '--json']);

    // Assert
    should(code).equal(0);
    should(world.stdout() + world.stderr()).not.containEql(SENTINEL);
    should(world.stdout()).containEql('[typed text]');
  });

  it('should not repeat the text when the daemon refuses with it in the sentence, or throws one', async () => {
    // Arrange
    daemon.answer(TOOLS, () => {
      throw new Error(`no field takes "${SENTINEL}"`);
    });
    const world = cliWorld(daemon, { stdin: SENTINEL });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#pw', '--stdin', '--ferret', 'f1']);

    // Assert
    should(code).equal(1);
    should(world.stdout() + world.stderr()).not.containEql(SENTINEL);
    should(world.stderr()).equal('no field takes "[typed text]"\n');
  });

  it('should be what the whole-browser `browser type` takes too', async () => {
    // Arrange
    daemon.answer('POST /v1/ferrets/:ferretId/browser', { status: { state: 'stopped' } });
    const world = cliWorld(daemon, { stdin: SENTINEL, ownFerret: 'f1' });

    // Act
    await world.run(['browser', 'type', '#pw', '--stdin']);

    // Assert
    should(typedInput()).deepEqual({ action: 'type', selector: '#pw', text: SENTINEL });
    should(world.stdout() + world.stderr()).not.containEql(SENTINEL);
  });

  it('should refuse text on the command line beside --stdin, and both sources at once, as mistyped', async () => {
    // Arrange
    const world = cliWorld(daemon, { stdin: SENTINEL });

    // Act
    const beside = await world.run(['browser', 'page', 'type', 'app', '#pw', 'also', '--stdin']);
    const both = await world.run(['browser', 'page', 'type', 'app', '#pw', '--stdin', '--secret', 'PW']);

    // Assert
    should([beside, both]).deepEqual([2, 2]);
    should(world.stderr()).containEql('--stdin takes the text from standard input: leave it off the command line');
    should(daemon.calls).have.length(0);
  });
});

describe('typing sensitive text: --secret NAME', () => {
  it('should refuse, in a sentence that names the gap, sending nothing — never typing the name as text', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#pw', '--secret', 'APP_PASSWORD']);

    // Assert
    should(code).equal(1);
    should(world.stderr()).equal(`${SECRET_TYPING_GAP}\n`);
    should(daemon.calls).have.length(0);
  });

  it('should take only a NAME: a pasted value is refused as mistyped and never echoed', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#pw', '--secret', SENTINEL]);

    // Assert
    should(code).equal(2);
    should(world.stderr()).containEql('--secret takes the NAME of a stored secret');
    should(world.stdout() + world.stderr()).not.containEql(SENTINEL);
    should(daemon.calls).have.length(0);
  });
});
