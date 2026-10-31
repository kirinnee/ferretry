import { describe, it } from 'bun:test';
import should from 'should';
import { AGENT_TOOL_MAX_DOWNLOAD_BYTES } from '@ferretry/protocol';
import { AgentFileError, AgentToolError, BrowserTransportError } from '../../../src/lib/index.ts';
import { agent, agentToolWorld, person } from './support.ts';

const refusal = async (work: Promise<unknown>): Promise<AgentToolError> => {
  const error = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  should(error).be.instanceOf(AgentToolError);
  return error as AgentToolError;
};

const opened = async () => {
  const world = agentToolWorld();
  await world.service.call(agent, { tool: 'browser.open', name: 'app' });
  world.audit.entries.length = 0;
  world.browser.acts.length = 0;
  return world;
};

describe('AgentToolService — browser.upload', () => {
  it('should hand the page the files the file service confined, in the mode asked, and release them', async () => {
    // Arrange
    const world = await opened();
    world.files.sizes = [2048, 4096];

    // Act
    const result = await world.service.call(agent, {
      tool: 'browser.upload',
      name: 'app',
      selector: '#file',
      files: ['reports/q3.pdf', { attachment: `att_${'a'.repeat(64)}` }],
      mode: 'drop',
    });

    // Assert
    should(world.files.prepared).deepEqual([['reports/q3.pdf', { attachment: `att_${'a'.repeat(64)}` }]]);
    should(world.browser.fileActions).deepEqual([
      {
        action: 'upload',
        target: { kind: 'selector', selector: '#file' },
        paths: ['/upload/0', '/upload/1'],
        mode: 'drop',
      },
    ]);
    should(world.files.released).equal(1);
    should(result.summary).startWith('Dropped 2 files (6.0 KiB) onto %browser:app');
  });

  it('should default to the input mode and take a ref', async () => {
    const world = await opened();

    const result = await world.service.call(agent, {
      tool: 'browser.upload',
      name: 'app',
      ref: 'e5',
      files: ['a.txt'],
    });

    should(world.browser.fileActions[0]).match({ target: { kind: 'ref', ref: 'e5' }, mode: 'input' });
    should(result.summary).startWith('Gave 1 file (1.0 KiB) to %browser:app');
  });

  it('should release the files even when the browser refuses, and still audit the attempt', async () => {
    // Arrange
    const world = await opened();
    world.browser.filesOnPage = async () => {
      throw new BrowserTransportError('upstream_failed', 'that element takes no files', 502);
    };

    // Act
    const error = await refusal(
      world.service.call(agent, { tool: 'browser.upload', name: 'app', selector: '#nope', files: ['a.txt'] }),
    );

    // Assert
    should(error.message).containEql('that element takes no files');
    should(world.files.released).equal(1);
    should(world.audit.entries).match([{ outcome: 'failed', detail: { tool: 'browser.upload', files: 1 } }]);
  });

  it('should refuse a path the file service refuses, in its own sentence, without touching the browser', async () => {
    // Arrange
    const world = await opened();
    world.files.failure = new AgentFileError('forbidden', 'that path is outside this session’s folder');

    // Act
    const error = await refusal(
      world.service.call(agent, { tool: 'browser.upload', name: 'app', selector: '#f', files: ['../../etc/passwd'] }),
    );

    // Assert
    should(error).match({ code: 'forbidden', message: 'that path is outside this session’s folder' });
    should(world.browser.fileActions).deepEqual([]);
    should(world.audit.entries).match([{ outcome: 'refused', detail: { tool: 'browser.upload' } }]);
  });

  it('should audit the count, total size, and each file by leaf name and size — never a path or content', async () => {
    // Arrange
    const world = await opened();
    world.files.sizes = [10, 20];

    // Act
    await world.service.call(agent, {
      tool: 'browser.upload',
      name: 'app',
      selector: '#file',
      files: ['secret-dir/passport.png', 'cv.pdf'],
    });

    // Assert
    should(world.audit.entries.map(entry => entry.detail)).deepEqual([
      {
        tool: 'browser.upload',
        by: 'agent',
        surface: '%browser:app',
        selector: '#file',
        files: 2,
        mode: 'input',
        bytes: 30,
        file1: 'passport.png (10 B)',
        file2: 'cv.pdf (20 B)',
      },
    ]);
    should(JSON.stringify(world.audit.entries)).not.containEql('secret-dir');
  });

  it('should put the driving marker up, as for any act that changes a page', async () => {
    const world = await opened();

    await world.service.call(agent, { tool: 'browser.upload', name: 'app', selector: '#f', files: ['a.txt'] });

    should(world.events.published.map(event => event.type)).containEql('surface.driving');
  });
});

describe('AgentToolService — browser.download and browser.pdf', () => {
  it('should save the staged download under the folder with the size cap, and tell where', async () => {
    // Arrange
    const world = await opened();

    // Act
    const result = await world.service.call(agent, { tool: 'browser.download', name: 'app', id: 'dl-3' });

    // Assert
    should(world.browser.fileActions).deepEqual([{ action: 'download', downloadId: 'dl-3' }]);
    should(world.files.saves).deepEqual([
      { name: 'report.csv', saveAs: undefined, overwrite: false, maxBytes: AGENT_TOOL_MAX_DOWNLOAD_BYTES },
    ]);
    should(result.summary).startWith('Saved %browser:app as downloads/report.csv (2.0 KiB)');
  });

  it('should pass saveAs and overwrite through, and ask the browser for the latest download by default', async () => {
    const world = await opened();

    await world.service.call(agent, {
      tool: 'browser.download',
      name: 'app',
      saveAs: 'data/out.csv',
      overwrite: true,
    });

    should(world.browser.fileActions).deepEqual([{ action: 'download' }]);
    should(world.files.saves[0]).match({ saveAs: 'data/out.csv', overwrite: true });
  });

  it('should print a PDF the same way, and audit size and extension only', async () => {
    // Arrange
    const world = await opened();
    world.browser.staged = { path: '/stage/pdf-1', name: 'My Bank Statement.pdf', size: 5000 };

    // Act
    const result = await world.service.call(agent, { tool: 'browser.pdf', name: 'app' });

    // Assert
    should(world.browser.fileActions).deepEqual([{ action: 'pdf' }]);
    should(result.summary).startWith('Printed %browser:app as downloads/My Bank Statement.pdf');
    should(world.audit.entries.map(entry => entry.detail)).deepEqual([
      { tool: 'browser.pdf', by: 'agent', surface: '%browser:app', size: 5000, extension: 'pdf' },
    ]);
    should(JSON.stringify(world.audit.entries)).not.containEql('Statement');
  });

  it('should scrub the name a page suggested for its download before saving or showing it', async () => {
    // Arrange
    const world = await opened();
    world.redactor.values.set('hunter2hunter2', 'PASSWORD');
    world.browser.staged = { path: '/stage/dl-1', name: 'export-hunter2hunter2.csv', size: 10 };

    // Act
    const result = await world.service.call(agent, { tool: 'browser.download', name: 'app' });

    // Assert
    should(world.files.saves[0]?.name).equal('export-[redacted:PASSWORD].csv');
    should(result.summary).containEql('export-[redacted:PASSWORD].csv');
    should(result.summary).not.containEql('hunter2');
  });

  it('should refuse in the file service’s own words when the destination is taken', async () => {
    const world = await opened();
    world.files.failure = new AgentFileError('conflict', 'downloads/report.csv exists; pass overwrite to replace it');

    const error = await refusal(world.service.call(agent, { tool: 'browser.download', name: 'app' }));

    should(error).match({ code: 'conflict', message: 'downloads/report.csv exists; pass overwrite to replace it' });
  });

  it('should refuse a page the person holds, from inside the browser’s queue', async () => {
    // Arrange
    const world = await opened();
    await world.service.control('s1', 'browser', { action: 'takeover', key: 'app' }, { by: 'local' }, person);
    world.browser.acts.length = 0;

    // Act
    const codes = await Promise.all(
      [
        { tool: 'browser.upload', name: 'app', selector: '#f', files: ['a.txt'] },
        { tool: 'browser.download', name: 'app' },
        { tool: 'browser.pdf', name: 'app' },
      ].map(async call => (await refusal(world.service.call(agent, call as never))).code),
    );

    // Assert
    should(codes).deepEqual(['taken_over', 'taken_over', 'taken_over']);
    should(world.browser.fileActions).deepEqual([]);
    should(world.files.saves).deepEqual([]);
  });
});

describe('AgentToolService — a download an act started', () => {
  it('should tell the agent the name and size and how to keep it, with the name scrubbed', async () => {
    // Arrange
    const world = await opened();
    world.redactor.values.set('tok-123456', 'TOKEN');
    world.browser.downloads = [{ id: 'dl-1', name: 'invoice-tok-123456.pdf', size: 3 * 1024 * 1024, state: 'ready' }];

    // Act
    const result = await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'a.export' });

    // Assert
    should(result.summary).containEql(
      'A download started: invoice-[redacted:TOKEN].pdf, 3.0 MiB — save it with browser_download (id dl-1).',
    );
    should(result.summary).not.containEql('tok-123456');
  });

  it('should say so when a download is still arriving or failed', async () => {
    const world = await opened();
    world.browser.downloads = [
      { id: 'dl-1', name: 'big.iso', state: 'downloading' },
      { id: 'dl-2', name: 'bad.zip', state: 'failed' },
    ];

    const result = await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'a' });

    should(result.summary).containEql('A download started: big.iso is still arriving');
    should(result.summary).containEql('A download (bad.zip) failed.');
  });
});

describe('AgentToolService — the files switch', () => {
  it('should need the files switch as well as the browser switch, for each file tool', async () => {
    // Arrange
    const world = await opened();
    world.policy.off.add('files');

    // Act
    const refused = await Promise.all(
      [
        { tool: 'browser.upload', name: 'app', selector: '#f', files: ['a.txt'] },
        { tool: 'browser.download', name: 'app' },
        { tool: 'browser.pdf', name: 'app' },
      ].map(async call => await refusal(world.service.call(agent, call as never))),
    );
    const click = await world.service.call(agent, { tool: 'browser.click', name: 'app', selector: 'a' });

    // Assert
    should(refused.map(error => error.code)).deepEqual(['forbidden', 'forbidden', 'forbidden']);
    should(refused[0]?.message).containEql('"What agents may control › Files" is off');
    should(world.browser.fileActions).deepEqual([]);
    should(click.summary).startWith('Done on %browser:app');
  });

  it('should refuse a file tool when the browser switch is off even with files on', async () => {
    const world = await opened();
    world.policy.off.add('browser');

    const error = await refusal(world.service.call(agent, { tool: 'browser.pdf', name: 'app' }));

    should(error.message).containEql('Browsers');
  });

  it('should not hold a person to the agents’ files switch', async () => {
    const world = await opened();
    world.policy.off.add('files');

    const result = await world.service.call(person, { tool: 'browser.pdf', name: 'app' });

    should(result.summary).startWith('Printed %browser:app');
  });
});
