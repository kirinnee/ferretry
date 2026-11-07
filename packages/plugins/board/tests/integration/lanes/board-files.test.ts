import { describe, it } from 'bun:test';
import type { StateFileDef } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { type BoardProjectId } from '../../../contract/index.ts';
import { type BoardFile, BoardFiles, BoardSwitchFiles, LaneSetFiles } from '../../../daemon/adapters/lanes/index.ts';
import {
  BOARD_SWITCH_UNAVAILABLE_MESSAGE,
  BoardSwitchUnavailableError,
  LANE_SET_UNAVAILABLE_MESSAGE,
  LANE_TEMPLATES,
  LaneSetUnavailableError,
  type LaneSet,
} from '../../../daemon/lib/lanes/index.ts';
import manifest from '../../../manifest.ts';

const FILE = manifest.data.state.find(file => file.name === 'boards') as StateFileDef<string, BoardFile>;
const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10' as BoardProjectId;
const OTHER = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a11' as BoardProjectId;

const proposal = (version: number): LaneSet => ({
  projectId: PROJECT,
  version,
  confirmedBy: null,
  proposedBy: 'denisha',
  ...LANE_TEMPLATES.pr,
});

const world = () => {
  const folder = new MemoryStateFolder();
  const files = new BoardFiles(folder.port([FILE]), FILE);
  return { folder, lanes: new LaneSetFiles(files), switches: new BoardSwitchFiles(files) };
};

describe('the lane-set files (one board file per project)', () => {
  it('should read no lanes for a project that has none', async () => {
    should(await world().lanes.read(PROJECT)).equal(null);
  });

  it('should write a decided set into the project’s own board file and read it back', async () => {
    const { folder, lanes } = world();

    const result = await lanes.transact(PROJECT, current => ({
      next: proposal((current?.version ?? 0) + 1),
      result: 'ok',
    }));

    should(result).equal('ok');
    should(await lanes.read(PROJECT)).eql(proposal(1));
    should([...folder.files.keys()]).eql([`boards/${PROJECT}.json`]);
    const stored = JSON.parse(folder.raw(FILE, PROJECT) ?? '{}');
    should(Object.keys(stored)[0]).equal('format');
    should(stored.switch).eql({ projectId: PROJECT, on: false, setBy: 'default', setAt: null });
  });

  it('should keep the stored set when the decision writes nothing', async () => {
    const { lanes } = world();
    await lanes.transact(PROJECT, () => ({ next: proposal(1), result: undefined }));

    const result = await lanes.transact(PROJECT, current => ({ result: current?.version }));

    should(result).equal(1);
    should(await lanes.read(PROJECT)).eql(proposal(1));
  });

  it('should write nothing for a project whose decision keeps nothing', async () => {
    const { folder, lanes } = world();

    await lanes.transact(PROJECT, () => ({ result: undefined }));

    should(folder.files.size).equal(0);
  });

  it('should let only one of two racing edits win a version', async () => {
    const { lanes } = world();
    await lanes.transact(PROJECT, () => ({ next: proposal(1), result: undefined }));
    const bump = async () =>
      await lanes.transact(PROJECT, current => ({
        next: proposal((current?.version ?? 0) + 1),
        result: (current?.version ?? 0) + 1,
      }));

    should((await Promise.all([bump(), bump()])).sort()).eql([2, 3]);
  });

  it('should keep one project’s file apart from another’s', async () => {
    const { lanes } = world();
    await lanes.transact(PROJECT, () => ({ next: proposal(1), result: undefined }));

    should(await lanes.read(OTHER)).equal(null);
  });

  it('should refuse a damaged file with the fixed words, and never overwrite it', async () => {
    const { folder, lanes } = world();
    folder.plant(FILE, '{ not json', PROJECT);

    const read = await lanes.read(PROJECT).then(
      () => undefined,
      (error: unknown) => error,
    );
    const write = await lanes.transact(PROJECT, () => ({ next: proposal(1), result: undefined })).then(
      () => undefined,
      (error: unknown) => error,
    );

    should(read).be.instanceOf(LaneSetUnavailableError);
    should((read as Error).message).equal(LANE_SET_UNAVAILABLE_MESSAGE);
    should(write).be.instanceOf(LaneSetUnavailableError);
    should(folder.raw(FILE, PROJECT)).equal('{ not json');
  });

  it('should refuse a lane set its own strict schema refuses, though the stored shape reads', async () => {
    const { folder, lanes } = world();
    const doc = { format: 1, project: PROJECT, switch: { projectId: PROJECT, on: false, setBy: 'default', setAt: null }, laneSet: { projectId: PROJECT, version: 1, confirmedBy: null, proposedBy: 'x', lanes: [{ id: 'Bad' }] } };
    folder.plant(FILE, JSON.stringify(doc), PROJECT);

    await lanes.read(PROJECT).then(
      () => {
        throw new Error('read a lane set it could not use');
      },
      error => should(error).be.instanceOf(LaneSetUnavailableError),
    );
  });

  it('should refuse a file that names another project', async () => {
    const { folder, lanes } = world();
    folder.plant(FILE, JSON.stringify({ format: 1, project: OTHER, switch: { projectId: OTHER, on: false, setBy: 'default', setAt: null }, laneSet: null }), PROJECT);

    await lanes.read(PROJECT).then(
      () => {
        throw new Error('read another project’s board');
      },
      error => should(error).be.instanceOf(LaneSetUnavailableError),
    );
  });

  it('should refuse a file of another format', async () => {
    const { folder, lanes } = world();
    folder.plant(FILE, JSON.stringify({ format: 2, project: PROJECT }), PROJECT);

    await lanes.read(PROJECT).then(
      () => {
        throw new Error('read a newer format');
      },
      error => should(error).be.instanceOf(LaneSetUnavailableError),
    );
  });
});

describe('the board switch files (the same file)', () => {
  it('should read null for a board nobody switched', async () => {
    should(await world().switches.read(PROJECT)).equal(null);
  });

  it('should store the owner’s switch and keep the lane set beside it', async () => {
    const { lanes, switches } = world();
    await lanes.transact(PROJECT, () => ({ next: proposal(1), result: undefined }));

    const stored = await switches.set(PROJECT, true, '2026-11-01T12:00:00.000Z');

    should(stored).eql({ projectId: PROJECT, on: true, setBy: 'owner', setAt: '2026-11-01T12:00:00.000Z' });
    should(await switches.read(PROJECT)).eql(stored);
    should(await lanes.read(PROJECT)).eql(proposal(1));
  });

  it('should keep the switch when the lanes change', async () => {
    const { lanes, switches } = world();
    await switches.set(PROJECT, true, '2026-11-01T12:00:00.000Z');

    await lanes.transact(PROJECT, () => ({ next: proposal(1), result: undefined }));

    should((await switches.read(PROJECT))?.on).be.true();
  });

  it('should switch a board that has no lanes yet, leaving its lane set empty', async () => {
    const { folder, lanes, switches } = world();

    await switches.set(PROJECT, false, '2026-11-01T12:00:00.000Z');

    should(await lanes.read(PROJECT)).equal(null);
    should(JSON.parse(folder.raw(FILE, PROJECT) ?? '{}').laneSet).equal(null);
  });

  it('should refuse a damaged file with its own fixed words', async () => {
    const { folder, switches } = world();
    folder.plant(FILE, 'nope', PROJECT);

    const error = await switches.read(PROJECT).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    should(error).be.instanceOf(BoardSwitchUnavailableError);
    should((error as Error).message).equal(BOARD_SWITCH_UNAVAILABLE_MESSAGE);
  });
});
