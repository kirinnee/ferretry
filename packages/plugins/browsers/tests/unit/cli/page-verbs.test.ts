import { beforeEach, describe, it } from 'bun:test';
import should from 'should';
import { cliWorld, FakeDaemon, type Recorded, toolText } from '../../support/cli.ts';

const TOOLS = 'POST /v1/ferrets/:ferretId/surfaces/browser/tools';

let daemon: FakeDaemon;
beforeEach(() => {
  daemon = new FakeDaemon();
});

/** The one tool call a verb made as the ferret itself, and what it asked. */
const asked = (): { name: string; input: Record<string, unknown> } => {
  const [call] = daemon.calls as Recorded[];
  if (call?.via !== 'tool') throw new Error('the verb did not call its own tool');
  return { name: call.name, input: call.input as Record<string, unknown> };
};

describe('the page verbs, as the ferret they run inside', () => {
  const cases: readonly (readonly [string, readonly string[], string, Record<string, unknown>])[] = [
    ['list', ['browser', 'page', 'list'], 'browser_list', {}],
    [
      'open',
      ['browser', 'page', 'open', 'app', 'https://x.test/'],
      'browser_open',
      { name: 'app', url: 'https://x.test/' },
    ],
    [
      'open incognito',
      ['browser', 'page', 'open', 'app', '--incognito'],
      'browser_open',
      { name: 'app', incognito: true },
    ],
    [
      'open ask',
      ['browser', 'page', 'open', 'app', '--ask', 'sign in'],
      'browser_open',
      { name: 'app', askOwner: 'sign in' },
    ],
    [
      'navigate',
      ['browser', 'page', 'navigate', 'app', 'https://x.test/'],
      'browser_navigate',
      { name: 'app', url: 'https://x.test/' },
    ],
    [
      'navigate back',
      ['browser', 'page', 'navigate', 'app', 'back'],
      'browser_navigate',
      { name: 'app', history: 'back' },
    ],
    ['click selector', ['browser', 'page', 'click', 'app', '#go'], 'browser_click', { name: 'app', selector: '#go' }],
    [
      'click ref',
      ['browser', 'page', 'click', 'app', 'e12', '--double'],
      'browser_click',
      { name: 'app', ref: 'e12', double: true },
    ],
    [
      'click point',
      ['browser', 'page', 'click', 'app', '120,340', '--right'],
      'browser_click',
      { name: 'app', x: 120, y: 340, button: 'right' },
    ],
    [
      'type',
      ['browser', 'page', 'type', 'app', '#q', 'hello', 'world', '--submit'],
      'browser_type',
      { name: 'app', selector: '#q', text: 'hello world', submit: true },
    ],
    ['hover', ['browser', 'page', 'hover', 'app', 'e3'], 'browser_hover', { name: 'app', ref: 'e3' }],
    [
      'drag points',
      ['browser', 'page', 'drag', 'app', '1,2', '30,40', '--steps', '5'],
      'browser_drag',
      { name: 'app', fromX: 1, fromY: 2, toX: 30, toY: 40, steps: 5 },
    ],
    [
      'press',
      ['browser', 'page', 'press', 'app', 'Enter', 'Tab'],
      'browser_press',
      { name: 'app', keys: ['Enter', 'Tab'] },
    ],
    [
      'press on',
      ['browser', 'page', 'press', 'app', 'Enter', '--on', '#q'],
      'browser_press',
      { name: 'app', keys: ['Enter'], selector: '#q' },
    ],
    [
      'scroll by',
      ['browser', 'page', 'scroll', 'app', '--by', '0,-600'],
      'browser_scroll',
      { name: 'app', deltaX: 0, deltaY: -600 },
    ],
    [
      'scroll pages',
      ['browser', 'page', 'scroll', 'app', '--pages', '-1'],
      'browser_scroll',
      { name: 'app', pages: -1 },
    ],
    [
      'select',
      ['browser', 'page', 'select', 'app', '#s', 'uk', 'us'],
      'browser_select',
      { name: 'app', selector: '#s', values: ['uk', 'us'] },
    ],
    [
      'check',
      ['browser', 'page', 'check', 'app', '#cb'],
      'browser_check',
      { name: 'app', selector: '#cb', checked: true },
    ],
    [
      'check off',
      ['browser', 'page', 'check', 'app', '#cb', '--off'],
      'browser_check',
      { name: 'app', selector: '#cb', checked: false },
    ],
    [
      'highlight clear',
      ['browser', 'page', 'highlight', 'app', '--clear'],
      'browser_highlight',
      { name: 'app', clear: true },
    ],
    ['read', ['browser', 'page', 'read', 'app'], 'browser_read', { name: 'app' }],
    [
      'read snapshot',
      ['browser', 'page', 'read', 'app', '--snapshot'],
      'browser_read',
      { name: 'app', mode: 'snapshot' },
    ],
    [
      'read find',
      ['browser', 'page', 'read', 'app', '--find', 'Sign in'],
      'browser_read',
      { name: 'app', mode: 'snapshot', find: 'Sign in' },
    ],
    [
      'read a11y of',
      ['browser', 'page', 'read', 'app', '--a11y', '--selector', 'main'],
      'browser_read',
      { name: 'app', mode: 'a11y', selector: 'main' },
    ],
    [
      'dialog',
      ['browser', 'page', 'dialog', 'app', 'accept', '--text', 'Ada'],
      'browser_dialog',
      { name: 'app', action: 'accept', promptText: 'Ada' },
    ],
    ['tabs', ['browser', 'page', 'tabs'], 'browser_tabs', { action: 'list' }],
    [
      'tabs adopt',
      ['browser', 'page', 'tabs', 'adopt', 'p2', 'docs'],
      'browser_tabs',
      { action: 'adopt', id: 'p2', as: 'docs' },
    ],
    [
      'console',
      ['browser', 'page', 'console', 'app', '--level', 'error', '--since', '3', '--limit', '50'],
      'browser_console',
      { name: 'app', level: 'error', since: 3, limit: 50 },
    ],
    [
      'network list',
      ['browser', 'page', 'network', 'app', '--filter', 'api', '--type', 'xhr,fetch'],
      'browser_network',
      { name: 'app', action: 'list', filter: 'api', types: ['xhr', 'fetch'] },
    ],
    [
      'network get',
      ['browser', 'page', 'network', 'app', 'r12'],
      'browser_network',
      { name: 'app', action: 'get', id: 'r12' },
    ],
    [
      'emulate',
      [
        'browser',
        'page',
        'emulate',
        'app',
        '--viewport',
        '390x844',
        '--color-scheme',
        'dark',
        '--geolocation',
        '52.5,13.4,50',
        '--offline',
        '--latency',
        '200',
        '--permission',
        'geolocation',
        '--cpu-throttle',
        '4',
      ],
      'browser_emulate',
      {
        name: 'app',
        viewport: { width: 390, height: 844 },
        media: { colorScheme: 'dark' },
        geolocation: { latitude: 52.5, longitude: 13.4, accuracy: 50 },
        network: { offline: true, latency: 200 },
        permissions: ['geolocation'],
        cpuThrottle: 4,
      },
    ],
    [
      'emulate reset',
      ['browser', 'page', 'emulate', 'app', '--reset'],
      'browser_emulate',
      { name: 'app', reset: true },
    ],
    [
      'upload',
      ['browser', 'page', 'upload', 'app', '#f', 'a.txt', `att_${'a'.repeat(64)}`, '--drop'],
      'browser_upload',
      { name: 'app', selector: '#f', files: ['a.txt', { attachment: `att_${'a'.repeat(64)}` }], mode: 'drop' },
    ],
    [
      'download',
      ['browser', 'page', 'download', 'app', 'out/a.csv', '--id', 'dl-1', '--overwrite'],
      'browser_download',
      { name: 'app', saveAs: 'out/a.csv', id: 'dl-1', overwrite: true },
    ],
    ['pdf', ['browser', 'page', 'pdf', 'app'], 'browser_pdf', { name: 'app' }],
    [
      'eval',
      ['browser', 'page', 'eval', 'app', '() => document.title', '--timeout', '2000'],
      'browser_eval',
      { name: 'app', function: '() => document.title', timeoutMs: 2000 },
    ],
    ['close', ['browser', 'page', 'close', 'app'], 'browser_close', { name: 'app' }],
    [
      'ask',
      ['browser', 'page', 'ask', 'app', 'solve', 'the', 'captcha'],
      'browser_ask_owner',
      { name: 'app', message: 'solve the captcha' },
    ],
  ];

  for (const [title, line, tool, input] of cases)
    it(`should send ${title} as ${tool}`, async () => {
      // Arrange
      daemon.answer(tool, toolText('Done.'));
      const world = cliWorld(daemon);

      // Act
      const code = await world.run(line);

      // Assert
      should(code).equal(0);
      should(asked()).deepEqual({ name: tool, input });
      should(world.stdout()).equal('Done.\n');
    });

  it('should list pages with their popups and the ones that are not the ferret’s', async () => {
    // Arrange
    daemon.answer(
      'browser_list',
      toolText('2 browser pages: %browser:app, %browser:p2.', {
        surfaces: [
          { id: 'p1', name: 'app', title: 'Home', url: 'https://x.test/' },
          { id: 'p2', title: 'Popup', url: 'https://x.test/p', openerId: 'p1', available: false },
        ],
      }),
    );
    const world = cliWorld(daemon);

    // Act
    await world.run(['browser', 'page', 'list']);

    // Assert
    should(world.stdout()).equal(
      '2 browser pages: %browser:app, %browser:p2.\n  app  Home  https://x.test/\n  p2  Popup  https://x.test/p  (popup of p1)  [not yours]\n',
    );
  });

  it('should print what the daemon refused in its own words, on stderr, and exit 1', async () => {
    // Arrange
    daemon.answer(
      'browser_click',
      toolText(
        '%browser:app is taken over by you: it is not yours to act on until it is handed back.',
        undefined,
        true,
      ),
    );
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'click', 'app', '#go']);

    // Assert
    should(code).equal(1);
    should(world.stdout()).equal('');
    should(world.stderr()).containEql('is taken over by you');
  });

  it('should say a refusal the daemon threw (a person’s route answers with an error status) and exit 1', async () => {
    // Arrange
    daemon.answer(TOOLS, () => {
      throw new Error('taken_over: %browser:app is taken over; hand it back first');
    });
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'click', 'app', '#go', '--ferret', 'f1']);

    // Assert
    should(code).equal(1);
    should(world.stderr()).equal('taken_over: %browser:app is taken over; hand it back first\n');
  });

  it('should say, when this build has no tool door, to name the ferret yourself', async () => {
    // Arrange
    const world = cliWorld(daemon, { withTools: false });

    // Act
    const code = await world.run(['browser', 'page', 'list']);

    // Assert
    should(code).equal(1);
    should(world.stderr()).containEql('pass --ferret <id>');
  });
});

describe('the page verbs, as a person acting on a ferret', () => {
  it('should post the tool to that ferret’s route as the dotted call, with -s, --session or --ferret', async () => {
    // Arrange
    daemon.answer(TOOLS, toolText('Done on %browser:app.'));
    const world = cliWorld(daemon);

    // Act
    const codes = [
      await world.run(['browser', 'page', 'click', 'app', '#go', '--ferret', 'f1']),
      await world.run(['browser', 'page', 'click', 'app', '#go', '--session', 'f2']),
      await world.run(['browser', 'page', 'click', 'app', '#go', '-s', 'f3']),
    ];

    // Assert
    should(codes).deepEqual([0, 0, 0]);
    should(daemon.calls.map(call => (call.via === 'route' ? call.init : undefined))).deepEqual([
      { params: { ferretId: 'f1' }, body: { tool: 'browser.click', name: 'app', selector: '#go' } },
      { params: { ferretId: 'f2' }, body: { tool: 'browser.click', name: 'app', selector: '#go' } },
      { params: { ferretId: 'f3' }, body: { tool: 'browser.click', name: 'app', selector: '#go' } },
    ]);
  });

  it('should take a page over, hand it back and hand it over, and show who holds what', async () => {
    // Arrange
    const view = {
      sessionId: 'f1',
      driving: [
        {
          surface: 'browser',
          id: 'p1',
          name: 'app',
          agentSessionId: 'f1',
          agentName: 'Hadi',
          since: '2026-11-13T09:30:00.000Z',
          until: '2026-11-13T10:00:00.000Z',
        },
      ],
      takeovers: [
        { surface: 'browser', id: 'p2', name: 'docs', by: { by: 'local' }, since: '2026-11-13T09:00:00.000Z' },
      ],
      handed: [
        { surface: 'browser', id: 'p3', by: { by: 'human', deviceId: 'd1' }, at: '2026-11-13T09:40:00.000Z' },
        { surface: 'terminal', id: 't', by: { by: 'local' }, at: '2026-11-13T09:40:00.000Z' },
      ],
      opened: [],
      asked: [],
    };
    daemon
      .answer('POST /v1/ferrets/:ferretId/surfaces/browser/control', view)
      .answer('GET /v1/ferrets/:ferretId/surfaces/browser/control', view);
    const world = cliWorld(daemon);

    // Act
    const taken = await world.run(['browser', 'page', 'takeover', 'docs', '--ferret', 'f1']);
    const back = await world.run(['browser', 'page', 'handback', 'docs', '--ferret', 'f1']);
    const over = await world.run(['browser', 'page', 'handover', 'app', '--ferret', 'f1']);
    const shown = await world.run(['browser', 'page', 'control', '--ferret', 'f1']);

    // Assert
    should([taken, back, over, shown]).deepEqual([0, 0, 0, 0]);
    should(
      daemon.calls
        .filter(call => call.via === 'route' && call.route.startsWith('POST'))
        .map(call => (call as { init?: { body?: unknown } }).init?.body),
    ).deepEqual([
      { action: 'takeover', key: 'docs' },
      { action: 'handback', key: 'docs' },
      { action: 'handover', key: 'app' },
    ]);
    should(world.out[3]).equal(
      '%browser:app  driven by Hadi until 2026-11-13T10:00:00.000Z\n%browser:docs  taken over by this computer since 2026-11-13T09:00:00.000Z\n%browser:p3  handed to the ferret by device d1\n',
    );
  });

  it('should refuse takeover, handback, handover and control without a ferret, as a person’s act', async () => {
    // Arrange
    const world = cliWorld(daemon);

    // Act
    const codes = [
      await world.run(['browser', 'page', 'takeover', 'app']),
      await world.run(['browser', 'page', 'handback', 'app']),
      await world.run(['browser', 'page', 'handover', 'app']),
      await world.run(['browser', 'page', 'control']),
    ];

    // Assert
    should(codes).deepEqual([2, 2, 2, 2]);
    should(world.stderr()).containEql('a person’s action on a ferret: pass --ferret <id>');
    should(daemon.calls).have.length(0);
  });
});

describe('the verbs refuse what was mistyped, with a sentence and a non-zero exit, and send nothing', () => {
  it('should refuse an unknown option', async () => {
    const world = cliWorld(daemon);
    should(await world.run(['browser', 'page', 'click', 'app', '#go', '--douuble'])).equal(2);
    should(world.stderr()).containEql('browser page click has no option --douuble');
    should(daemon.calls).have.length(0);
  });

  it('should refuse a missing word', async () => {
    const world = cliWorld(daemon);
    should(await world.run(['browser', 'page', 'click', 'app'])).equal(2);
    should(world.stderr()).equal('browser page click needs the target\n');
  });

  it('should refuse a point where only an element will do', async () => {
    const world = cliWorld(daemon);
    should(await world.run(['browser', 'page', 'type', 'app', '1,2', 'hi'])).equal(2);
    should(world.stderr()).containEql('takes a ref or a selector, not a point');
  });

  it('should refuse a wait budget out of range', async () => {
    const world = cliWorld(daemon);
    should(await world.run(['browser', 'page', 'wait', 'app', '--text', 'x', '--timeout', '999999'])).equal(2);
    should(world.stderr()).equal('--timeout must be between 100 and 120000 milliseconds\n');
  });
});

describe('browser page wait', () => {
  it('should ask in slices to the total budget and exit 1 when the condition never held', async () => {
    // Arrange
    daemon.answer('browser_wait_for', toolText('Not yet.', { matched: false }));
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'wait', 'app', '--text', 'Done', '--timeout', '60000']);

    // Assert
    should(code).equal(1);
    should(daemon.calls.map(call => (call as { input: { timeoutMs: number } }).input.timeoutMs)).deepEqual([
      25_000, 25_000, 10_000,
    ]);
    should(world.stderr()).equal('Not yet.\n');
  });

  it('should stop at the first slice that matched and exit 0', async () => {
    // Arrange
    let slices = 0;
    daemon.answer('browser_wait_for', () => toolText('Matched.', { matched: ++slices === 2 }));
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'wait', 'app', '--text', 'Done', '--timeout', '100000']);

    // Assert
    should(code).equal(0);
    should(slices).equal(2);
  });

  it('should ask once for a plain time wait', async () => {
    // Arrange
    daemon.answer('browser_wait_for', toolText('Waited.'));
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'wait', 'app', '--time', '500']);

    // Assert
    should(code).equal(0);
    should(daemon.calls).have.length(1);
    should((daemon.calls[0] as { input: unknown }).input).deepEqual({ name: 'app', time: 500 });
  });

  it('should stop at once on a refusal', async () => {
    // Arrange
    daemon.answer('browser_wait_for', toolText('The page is held.', undefined, true));
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'wait', 'app', '--text', 'Done', '--timeout', '60000']);

    // Assert
    should(code).equal(1);
    should(daemon.calls).have.length(1);
  });
});

describe('browser page screenshot', () => {
  it('should write the picture to the file and say so', async () => {
    // Arrange
    daemon.answer(
      'browser_screenshot',
      toolText('Screenshot of %browser:app.', {
        picture: { mime: 'image/png', base64: Buffer.from('PNGBYTES').toString('base64') },
      }),
    );
    const world = cliWorld(daemon);

    // Act
    const code = await world.run([
      'browser',
      'page',
      'screenshot',
      'app',
      'out/shot.png',
      '--full-page',
      '--jpeg',
      '--of',
      '#hero',
    ]);

    // Assert
    should(code).equal(0);
    should(Buffer.from(world.files.get('out/shot.png') ?? new Uint8Array()).toString()).equal('PNGBYTES');
    should(world.stdout()).equal('Screenshot of %browser:app.\nscreenshot written to out/shot.png\n');
    should(asked().input).deepEqual({ name: 'app', selector: '#hero', fullPage: true, format: 'jpeg' });
  });

  it('should exit 1 and write no file when the daemon sent no picture', async () => {
    // Arrange
    daemon.answer('browser_screenshot', toolText('Screenshot of %browser:app.'));
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'screenshot', 'app', 'shot.png']);

    // Assert
    should(code).equal(1);
    should(world.files.size).equal(0);
    should(world.stderr()).containEql('no screenshot bytes');
  });
});

describe('--json', () => {
  it('should print the answer as data on stdout, without a picture’s bytes', async () => {
    // Arrange
    daemon.answer('browser_list', toolText('1 browser page: %browser:app.', { surfaces: [{ id: 'p1', name: 'app' }] }));
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'list', '--json']);

    // Assert
    should(code).equal(0);
    should(JSON.parse(world.stdout())).deepEqual({
      text: '1 browser page: %browser:app.',
      surfaces: [{ id: 'p1', name: 'app' }],
    });
  });
});
