import { describe, it } from 'bun:test';
import should from 'should';
import {
  DOWNLOAD_SETTLE_MS,
  DownloadStage,
  type DownloadStageDisk,
  type StageableDownload,
} from '../../../../src/lib/index.ts';

const MINUTE = 60_000;

class FakeDisk implements DownloadStageDisk {
  readonly files = new Map<string, number>();
  readonly removed: string[] = [];
  async mkdirp(): Promise<void> {}
  async size(path: string): Promise<number> {
    const size = this.files.get(path);
    if (size === undefined) throw new Error('no such file');
    return size;
  }
  async remove(path: string): Promise<void> {
    this.removed.push(path);
    this.files.delete(path);
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.byteLength);
  }
}

class FakeDownload implements StageableDownload {
  release: () => void = () => undefined;
  private readonly arrived = new Promise<void>(resolve => {
    this.release = resolve;
  });
  constructor(
    private readonly disk: FakeDisk,
    private readonly name: string,
    private readonly size: number,
    private readonly outcome: 'ok' | 'fail' | 'wait' = 'ok',
  ) {}
  suggestedFilename(): string {
    return this.name;
  }
  async saveAs(path: string): Promise<void> {
    if (this.outcome === 'wait') await this.arrived;
    if (this.outcome === 'fail') throw new Error('network down');
    this.disk.files.set(path, this.size);
  }
}

const stageWorld = (options: { directory?: string | undefined; maxBytes?: number } = {}) => {
  const disk = new FakeDisk();
  const clock = { now: 1_000_000 };
  const stage = new DownloadStage({
    directory: 'directory' in options ? options.directory : '/stage',
    disk,
    now: () => clock.now,
    sleep: async milliseconds => {
      await new Promise(resolve => setTimeout(resolve, 0));
      clock.now += milliseconds;
    },
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  return { disk, clock, stage };
};

const refusal = async (work: Promise<unknown>): Promise<Error> => {
  const error = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  should(error).be.instanceOf(Error);
  return error as Error;
};

describe('DownloadStage — what a page downloaded', () => {
  it('should stage a download under a name the worker chose and report it once, with its size', async () => {
    // Arrange
    const { disk, stage } = stageWorld();
    stage.accept('p1', new FakeDownload(disk, '../../Quarterly Report.csv', 2048));

    // Act
    const first = await stage.notices('p1');
    const second = await stage.notices('p1');

    // Assert
    should(first).deepEqual([{ id: 'dl-1', name: 'Quarterly Report.csv', state: 'ready', size: 2048 }]);
    should(second).deepEqual([]);
    should([...disk.files.keys()]).deepEqual(['/stage/dl-1-Quarterly Report.csv']);
  });

  it('should report a download still arriving every time, then once it is whole', async () => {
    // Arrange
    const { disk, stage } = stageWorld();
    const slow = new FakeDownload(disk, 'big.iso', 9, 'wait');
    stage.accept('p1', slow);

    // Act
    const early = await stage.notices('p1');
    const again = await stage.notices('p1');
    slow.release();
    await stage.claim('p1');
    const done = await stage.notices('p1');

    // Assert
    should(early).deepEqual([{ id: 'dl-1', name: 'big.iso', state: 'downloading' }]);
    should(again).deepEqual(early);
    should(done).deepEqual([{ id: 'dl-1', name: 'big.iso', state: 'ready', size: 9 }]);
  });

  it('should report a failed download, remove what it left, and refuse to claim it', async () => {
    const { disk, stage } = stageWorld();
    stage.accept('p1', new FakeDownload(disk, 'bad.zip', 1, 'fail'));

    const notices = await stage.notices('p1');

    should(notices).deepEqual([{ id: 'dl-1', name: 'bad.zip', state: 'failed' }]);
    should((await refusal(stage.claim('p1', 'dl-1'))).message).containEql('did not finish');
  });

  it('should fail a download over the size cap and delete it', async () => {
    const { disk, stage } = stageWorld({ maxBytes: 100 });
    stage.accept('p1', new FakeDownload(disk, 'huge.bin', 101));

    const notices = await stage.notices('p1');

    should(notices[0]?.state).equal('failed');
    should(disk.removed).deepEqual(['/stage/dl-1-huge.bin']);
  });

  it('should stage and report nothing when the daemon named no directory', async () => {
    const { disk, stage } = stageWorld({ directory: undefined });

    stage.accept('p1', new FakeDownload(disk, 'a.csv', 1));

    should(await stage.notices('p1')).deepEqual([]);
    should(disk.files.size).equal(0);
    should((await refusal(stage.claim('p1'))).message).containEql('has not started a download');
  });

  it('should keep one page’s downloads from another page', async () => {
    const { disk, stage } = stageWorld();
    stage.accept('p1', new FakeDownload(disk, 'a.csv', 1));
    await stage.notices('p1');

    should(await stage.notices('p2')).deepEqual([]);
    should((await refusal(stage.claim('p2', 'dl-1'))).message).containEql('no download dl-1 on this page');
  });
});

describe('DownloadStage — saving what was staged', () => {
  it('should claim the page’s latest download by default, or a chosen one by id', async () => {
    const { disk, stage } = stageWorld();
    stage.accept('p1', new FakeDownload(disk, 'one.csv', 1));
    stage.accept('p1', new FakeDownload(disk, 'two.csv', 2));

    const latest = await stage.claim('p1');
    const chosen = await stage.claim('p1', 'dl-1');

    should(latest).deepEqual({ path: '/stage/dl-2-two.csv', name: 'two.csv', size: 2 });
    should(chosen.name).equal('one.csv');
  });

  it('should say so in one sentence when the page has downloaded nothing, after a short wait', async () => {
    const { stage, clock } = stageWorld();
    const start = clock.now;

    const error = await refusal(stage.claim('p1'));

    should(error.message).equal('this page has not started a download');
    should(clock.now - start).be.aboveOrEqual(DOWNLOAD_SETTLE_MS);
  });

  it('should say a download is still running when it has not finished by the time the save gave up', async () => {
    const { disk, stage } = stageWorld();
    stage.accept('p1', new FakeDownload(disk, 'big.iso', 9, 'wait'));

    const error = await refusal(stage.claim('p1', 'dl-1'));

    should(error.message).containEql('still downloading');
  });

  it('should keep a staged file for 15 minutes, then forget it and delete it', async () => {
    // Arrange
    const { disk, stage, clock } = stageWorld();
    stage.accept('p1', new FakeDownload(disk, 'a.csv', 1));
    await stage.notices('p1');

    // Act
    clock.now += 14 * MINUTE;
    const kept = await stage.claim('p1', 'dl-1');
    clock.now += 2 * MINUTE;
    const error = await refusal(stage.claim('p1', 'dl-1'));
    await Promise.resolve();

    // Assert
    should(kept.size).equal(1);
    should(error.message).containEql('kept for 15 minutes');
    should(disk.removed).deepEqual(['/stage/dl-1-a.csv']);
  });
});

describe('DownloadStage — a printed PDF', () => {
  it('should stage the bytes under a sanitised title and offer them, without announcing them as a download', async () => {
    // Arrange
    const { disk, stage } = stageWorld();

    // Act
    const staged = await stage.stagePdf(
      'p1',
      Buffer.from('%PDF-1.7 hello').toString('base64'),
      '../My Bank: Statement.pdf',
    );

    // Assert
    should(staged).deepEqual({ path: '/stage/pdf-1-My Bank_ Statement.pdf', name: 'My Bank_ Statement.pdf', size: 14 });
    should(disk.files.get(staged.path)).equal(14);
    should(await stage.notices('p1')).deepEqual([]);
    should((await refusal(stage.claim('p1', 'pdf-1'))).message).containEql('no download pdf-1');
  });

  it('should refuse a PDF over the save limit, and refuse when there is no staging directory', async () => {
    const small = stageWorld({ maxBytes: 4 });
    const none = stageWorld({ directory: undefined });

    should(
      (await refusal(small.stage.stagePdf('p1', Buffer.from('0123456789').toString('base64'), 't'))).message,
    ).containEql('larger than the save limit');
    should((await refusal(none.stage.stagePdf('p1', 'AAAA', 't'))).message).containEql('no place to stage');
  });
});

describe('DownloadStage.awaitStart — a click that may start a download', () => {
  it('should give up after the settle time when no download begins', async () => {
    const { clock, stage } = stageWorld();
    const began = clock.now;

    await stage.awaitStart('p1', 250);

    should(clock.now - began).be.aboveOrEqual(250);
  });

  it('should return as soon as the browser announces a download for that page', async () => {
    // Arrange
    const { disk, clock, stage } = stageWorld();
    const began = clock.now;
    const announce = setTimeout(() => stage.accept('p1', new FakeDownload(disk, 'a.csv', 1)), 0);

    // Act
    await stage.awaitStart('p1', 10_000);
    clearTimeout(announce);

    // Assert
    should(clock.now - began).be.below(10_000);
  });

  it('should not wait for a download that began before the click', async () => {
    const { disk, clock, stage } = stageWorld();
    stage.accept('p1', new FakeDownload(disk, 'old.csv', 1));
    const began = clock.now;

    await stage.awaitStart('p1', 250);

    should(clock.now - began).be.aboveOrEqual(250);
  });
});
