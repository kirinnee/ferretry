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

/** What a hidden value is printed as, and the start of what an answer that repeats a value too short to hide is. */
const MASK = '[typed text]';
const WITHHELD_START = '[withheld: ';

/** Quotes, a backslash, a newline, a tab and a slash: every character JSON and a URL rewrite. */
const AWKWARD = 'review "quoted"\nnext\\path\t/end';
const STATUS = {
  sessionId: 'f1',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 600,
  capacity: { running: 1, maximum: 3 },
  state: 'running',
  url: 'https://x.test/',
  title: 'Home',
  pages: [{ id: 'p1', url: 'https://x.test/', title: 'Home' }],
  activePageId: 'p1',
  pageState: 'ready',
  canGoBack: false,
  canGoForward: false,
};

/** Every way the CLI could print the awkward text back: it must be in none of them. */
const SPELLED_AWKWARD = [
  AWKWARD,
  JSON.stringify(AWKWARD).slice(1, -1),
  JSON.stringify(AWKWARD).slice(1, -1).replaceAll('/', '\\/'),
  encodeURIComponent(AWKWARD),
  encodeURIComponent(AWKWARD).replaceAll(/%[0-9A-F]{2}/gu, match => match.toLowerCase()),
];
const leaks = (out: string, spellings: readonly string[]): string[] => spellings.filter(each => out.includes(each));

describe('typed text in every spelling the answer could carry it in', () => {
  it('should not print the text, or its JSON, with --json, when the daemon echoes it', async () => {
    // Arrange
    daemon.answer('browser_type', toolText(`The field now reads ${AWKWARD}`));
    const world = cliWorld(daemon, { stdin: AWKWARD });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#f', '--stdin', '--json']);

    // Assert
    should(code).equal(0);
    should(leaks(world.stdout() + world.stderr(), SPELLED_AWKWARD)).deepEqual([]);
    should((JSON.parse(world.stdout()) as { text: string }).text).equal(`The field now reads ${MASK}`);
  });

  it('should not print it when the daemon already wrote it as JSON, with escaped slashes, or URL-encoded', async () => {
    // Arrange
    const asJson = JSON.stringify(AWKWARD).slice(1, -1);
    daemon.answer(
      'browser_type',
      toolText(`json ${asJson} slashes ${asJson.replaceAll('/', '\\/')} url ?q=${encodeURIComponent(AWKWARD)}`, {
        surfaces: [{ id: 'p1', title: AWKWARD, url: `https://x.test/?q=${encodeURIComponent(AWKWARD)}` }],
      }),
    );

    // Act
    const human = cliWorld(daemon, { stdin: AWKWARD });
    const asJsonCode = cliWorld(daemon, { stdin: AWKWARD });
    const humanCode = await human.run(['browser', 'page', 'type', 'app', '#f', '--stdin']);
    const jsonCode = await asJsonCode.run(['browser', 'page', 'type', 'app', '#f', '--stdin', '--json']);

    // Assert
    should([humanCode, jsonCode]).deepEqual([0, 0]);
    should(leaks(human.stdout() + human.stderr(), SPELLED_AWKWARD)).deepEqual([]);
    should(leaks(asJsonCode.stdout() + asJsonCode.stderr(), SPELLED_AWKWARD)).deepEqual([]);
    should(leaks(JSON.stringify(JSON.parse(asJsonCode.stdout())), SPELLED_AWKWARD)).deepEqual([]);
  });

  it('should not print non-ASCII text as \\uXXXX escapes, upper or lower case, whole or only the non-ASCII part', async () => {
    // Arrange
    const typed = 'caf\u00e9-pass/9';
    const escaped = [
      'caf\\u00e9-pass/9',
      'caf\\u00E9-pass\\/9',
      [...typed].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
      [...typed].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join(''),
    ];
    daemon.answer('browser_type', toolText(escaped.join(' | ')));
    const world = cliWorld(daemon, { stdin: typed });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#f', '--stdin', '--json']);

    // Assert
    should(code).equal(0);
    should(leaks(world.stdout(), [typed, ...escaped])).deepEqual([]);
  });

  it('should hide a value too short to mask by withholding the answer that repeats it, in both modes, and say so', async () => {
    // Arrange
    daemon.answer('browser_type', toolText('the field now reads QZ'));

    // Act
    const human = cliWorld(daemon, { stdin: 'QZ' });
    const asJson = cliWorld(daemon, { stdin: 'QZ' });
    const humanCode = await human.run(['browser', 'page', 'type', 'app', '#f', '--stdin']);
    const jsonCode = await asJson.run(['browser', 'page', 'type', 'app', '#f', '--stdin', '--json']);

    // Assert
    should([humanCode, jsonCode]).deepEqual([0, 0]);
    should(human.stdout()).startWith(WITHHELD_START);
    should(human.stdout()).not.containEql('QZ');
    should((JSON.parse(asJson.stdout()) as { text: string }).text).startWith(WITHHELD_START);
    should(asJson.stdout()).not.containEql('QZ');
  });

  it('should not withhold an answer that does not repeat a short value', async () => {
    // Arrange
    daemon.answer('browser_type', toolText('Done on %browser:app.'));
    const world = cliWorld(daemon, { stdin: 'QZ' });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#f', '--stdin']);

    // Assert
    should(code).equal(0);
    should(world.stdout()).equal('Done on %browser:app.\n');
  });

  it('should hide a one-character value, and a short value typed as words, the same way', async () => {
    // Arrange
    daemon.answer('browser_type', toolText('the field now reads 7'));
    const world = cliWorld(daemon, { stdin: '7\n' });
    const words = cliWorld(daemon);

    // Act
    const fromStdin = await world.run(['browser', 'page', 'type', 'app', '#f', '--stdin']);
    const fromWords = await words.run(['browser', 'page', 'type', 'app', '#f', '7']);

    // Assert
    should([fromStdin, fromWords]).deepEqual([0, 0]);
    should(world.stdout()).startWith(WITHHELD_START);
    should(words.stdout()).startWith(WITHHELD_START);
    should(world.stdout() + words.stdout()).not.containEql('7');
  });

  it('should not print it in a refusal the daemon answers, nor in an error thrown, in its JSON spelling', async () => {
    // Arrange
    const asJson = JSON.stringify(AWKWARD).slice(1, -1);
    daemon.answer('browser_type', toolText(`refused: "${asJson}" is not accepted`, undefined, true));
    daemon.answer(TOOLS, () => {
      throw new Error(`no field takes ${asJson} (${encodeURIComponent(AWKWARD)})`);
    });
    const refused = cliWorld(daemon, { stdin: AWKWARD });
    const thrown = cliWorld(daemon, { stdin: AWKWARD });

    // Act
    const refusedCode = await refused.run(['browser', 'page', 'type', 'app', '#f', '--stdin', '--json']);
    const thrownCode = await thrown.run(['browser', 'page', 'type', 'app', '#f', '--stdin', '--ferret', 'f1']);

    // Assert
    should([refusedCode, thrownCode]).deepEqual([1, 1]);
    should(leaks(refused.stdout() + refused.stderr(), SPELLED_AWKWARD)).deepEqual([]);
    should(leaks(thrown.stdout() + thrown.stderr(), SPELLED_AWKWARD)).deepEqual([]);
    should(thrown.stderr()).equal(`no field takes ${MASK} (${MASK})\n`);
  });

  it('should not print text read from standard input when the verb fails before it can type it', async () => {
    // Arrange
    daemon.answer('browser_type', () => {
      throw new Error(`cannot type ${AWKWARD}`);
    });
    const world = cliWorld(daemon, { stdin: AWKWARD });

    // Act
    const code = await world.run(['browser', 'page', 'type', 'app', '#f', '--stdin']);

    // Assert
    should(code).equal(1);
    should(leaks(world.stderr(), SPELLED_AWKWARD)).deepEqual([]);
  });

  it('should keep the text out of the whole-browser verb’s status, with --json, in any page title or address', async () => {
    // Arrange
    daemon.answer('POST /v1/ferrets/:ferretId/browser', {
      status: {
        ...STATUS,
        title: AWKWARD,
        pages: [{ id: 'p1', url: `https://x.test/?q=${encodeURIComponent(AWKWARD)}`, title: JSON.stringify(AWKWARD) }],
      },
    });
    const world = cliWorld(daemon, { stdin: AWKWARD, ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'type', '#f', '--stdin', '--json']);

    // Assert
    should(code).equal(0);
    should(leaks(world.stdout(), SPELLED_AWKWARD)).deepEqual([]);
    should(world.stdout()).containEql(MASK);
  });
});
