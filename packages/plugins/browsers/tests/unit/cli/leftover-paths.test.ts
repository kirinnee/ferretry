import { beforeEach, describe, it } from 'bun:test';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import should from 'should';
import { BrowserClient } from '../../../cli/lib/client.ts';
import { BrowserDispatcher } from '../../../cli/lib/dispatcher.ts';
import { distanceArgument, geolocationArgument } from '../../../cli/lib/inputs.ts';
import { UsageError } from '../../../cli/lib/args.ts';
import { verbTable } from '../../../cli/lib/verbs/index.ts';
import { cliWorld, FakeDaemon, toolText } from '../../support/cli.ts';
import { parseArgs } from '../../support/shell-argv.ts';

const BROWSER = 'POST /v1/ferrets/:ferretId/browser';
const PAGE = {
  url: 'https://x.test/',
  title: 'Home',
  pages: [{ id: 'p1', url: 'https://x.test/', title: 'Home' }],
  activePageId: 'p1',
  pageState: 'ready',
  canGoBack: false,
  canGoForward: false,
};
const STATUS = {
  sessionId: 'f1',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 600,
  capacity: { running: 1, maximum: 3 },
  state: 'running',
  ...PAGE,
};

let daemon: FakeDaemon;
beforeEach(() => {
  daemon = new FakeDaemon();
});

describe('a daemon answer this build cannot read', () => {
  it('should say so in one sentence and exit 1, whichever road the answer came by', async () => {
    // Arrange
    daemon.answer('browser_click', 'not a tool answer');
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'page', 'click', 'app', '#go']);

    // Assert
    should(code).equal(1);
    should(world.stderr()).equal('the daemon answered a browser tool in a shape this build does not read\n');
  });

  it('should still read a tool answer whose data is not the shape a tool lists', async () => {
    // Arrange
    daemon.answer('browser_list', toolText('3 pages', { surfaces: 'nope' }));
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'page', 'list']);

    // Assert
    should(code).equal(0);
    should(world.stdout()).equal('3 pages\n');
  });
});

describe('the handler the shell calls for a declared verb line', () => {
  it('should run that line over the words the shell hands it', async () => {
    // Arrange
    daemon.answer('GET /v1/ferrets/:ferretId/browser', STATUS);
    const out: string[] = [];
    const err: string[] = [];
    const io: TerminalIo = { out: text => void out.push(text), err: text => void err.push(text), isTty: false };
    const dispatcher = new BrowserDispatcher(
      verbTable({ script: '', unit: '', verifyUnit: '', timer: '' }),
      new BrowserClient(daemon.client()),
      io,
      { readStdin: async () => '', writeFile: async () => undefined },
    );

    // Act
    const code = await dispatcher.handler('browser status')(parseArgs(['--ferret', 'f1']));

    // Assert
    should(code).equal(0);
    should(err).deepEqual([]);
    should(out.join('')).containEql('f1  browser running  1280x800');
  });
});

describe('what a whole-browser answer prints', () => {
  it('should keep a screenshot’s bytes out of --json and keep everything else', async () => {
    // Arrange
    daemon.answer(BROWSER, {
      status: STATUS,
      result: { ...PAGE, actedPageId: 'p1', screenshotBase64: 'UE5HQllURVM=', screenshotFormat: 'png' },
    });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'reload', '--json']);

    // Assert
    should(code).equal(0);
    const data = JSON.parse(world.stdout()) as { result: Record<string, unknown> };
    should(data.result).not.have.property('screenshotBase64');
    should(data.result).have.property('screenshotFormat', 'png');
    should(data.result).have.property('url', 'https://x.test/');
  });

  it('should say when the daemon returned no screenshot bytes and write no file', async () => {
    // Arrange
    daemon.answer(BROWSER, { status: STATUS, result: { ...PAGE, actedPageId: 'p1' } });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'screenshot', 'shot.png']);

    // Assert
    should(code).equal(1);
    should(world.stderr()).equal('the daemon returned no screenshot bytes\n');
    should(world.files.size).equal(0);
  });

  it('should show who last acted and which page the agent is on', async () => {
    // Arrange
    daemon.answer('GET /v1/ferrets/:ferretId/browser', {
      ...STATUS,
      lastActor: { kind: 'human', at: '2026-11-13T09:00:00.000Z', action: 'click' },
      agentPage: { pageId: 'p1', kind: 'agent', action: 'navigate', at: '2026-11-13T09:01:00.000Z' },
    });
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'status']);

    // Assert
    should(code).equal(0);
    should(world.stdout()).containEql('last human: click at 2026-11-13T09:00:00.000Z\n');
    should(world.stdout()).containEql('agent page p1: navigate at 2026-11-13T09:01:00.000Z\n');
  });

  it('should say, when no page is driven or taken over, that none is', async () => {
    // Arrange
    daemon.answer('GET /v1/ferrets/:ferretId/surfaces/browser/control', {
      sessionId: 'f1',
      driving: [],
      takeovers: [],
      handed: [],
      opened: [],
      asked: [],
    });
    const world = cliWorld(daemon);

    // Act
    const code = await world.run(['browser', 'page', 'control', '--ferret', 'f1']);

    // Assert
    should(code).equal(0);
    should(world.stdout()).equal('no ferret is driving a browser page in f1, and none is taken over\n');
  });

  it('should refuse a viewport whose height is out of bounds before asking the daemon', async () => {
    // Arrange
    const world = cliWorld(daemon, { ownFerret: 'f1' });

    // Act
    const code = await world.run(['browser', 'resize', '800', '1']);

    // Assert
    should(code).equal(2);
    should(world.stderr()).containEql('height must be between');
    should(daemon.calls).have.length(0);
  });
});

describe('the small shapes an option takes', () => {
  it('should read a geolocation of two or three numbers and refuse anything else in one sentence', () => {
    should(geolocationArgument('52.5,13.4')).deepEqual({ latitude: 52.5, longitude: 13.4 });
    should(geolocationArgument('52.5, 13.4, 50')).deepEqual({ latitude: 52.5, longitude: 13.4, accuracy: 50 });
    for (const bad of ['52.5', '1,2,3,4', '1,,3', 'a,b']) {
      should(() => geolocationArgument(bad)).throw(UsageError, {
        message: `--geolocation must be LAT,LON or LAT,LON,ACCURACY, not "${bad}"`,
      });
    }
  });

  it('should read a scroll distance of exactly two numbers and refuse anything else in one sentence', () => {
    should(distanceArgument('0,300')).deepEqual({ deltaX: 0, deltaY: 300 });
    for (const bad of ['5', '1,2,3']) {
      should(() => distanceArgument(bad)).throw(UsageError, {
        message: `--by must be two numbers, dx,dy, not "${bad}"`,
      });
    }
  });
});
