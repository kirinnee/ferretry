import { describe, it } from 'bun:test';
import should from 'should';
import { sharingRepairNotices } from '../../../bin/fyd.ts';

const PHONE = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const LAPTOP = 'fy_device_id_cccccccccccccccccccccc';

describe('what the boot says about the one-time Sharing repair', () => {
  it('says nothing when there was nothing to do', () => {
    should(sharingRepairNotices(undefined)).deepEqual([]);
    should(sharingRepairNotices({ kind: 'repaired', deviceIds: [], unrecorded: [], failed: [] })).deepEqual([]);
  });

  it('names how many were turned on, and which were turned on without a record or not at all', () => {
    const said = sharingRepairNotices({ kind: 'repaired', deviceIds: [PHONE], unrecorded: [LAPTOP], failed: ['x'] });
    should(said).have.length(3);
    should(said[0]).match(/^Sharing was turned on for 1 paired device that held every other capability/u);
    should(said[0]).match(/daemon config history/u);
    should(said[1]).equal(`Sharing was turned on for ${LAPTOP}, but the grant journal could not record it`);
    should(said[2]).match(/^Sharing could not be turned on for x: the device record could not be written\./u);
    should(sharingRepairNotices({ kind: 'repaired', deviceIds: [PHONE, LAPTOP], unrecorded: [], failed: [] })[0]).match(
      /2 paired devices/u,
    );
  });

  it('gives each reason it skipped its own sentence, with the way to turn Sharing on', () => {
    const reasons = ['grants-undetermined', 'journal-too-large', 'journal-unreadable', 'failed'] as const;
    const sentences = reasons.map(reason => sharingRepairNotices({ kind: 'skipped', reason })[0] ?? '');
    should(new Set(sentences).size).equal(reasons.length);
    should(sentences[0]).match(/capability grants could not be read/u);
    for (const sentence of sentences) {
      should(sentence).match(/^Sharing was not turned on for devices paired before it existed: /u);
      should(sentence).match(/Settings › Devices/u);
      should(sentence).match(/device grant <device> sharing --use/u);
    }
  });
});
