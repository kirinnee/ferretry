import { describe, it } from 'bun:test';
import { LANE_CATEGORIES } from '@ferretry/protocol';
import should from 'should';
import { laneGuide } from '../../../src/lib/board/lane-guide';

describe('the lane guide under `task move --help`', () => {
  it('should say when a card belongs in every category, in lane order', () => {
    // Act
    const lines = laneGuide('fy').split('\n');

    // Assert
    const categoryLines = lines.filter(line => line.startsWith('  '));
    should(categoryLines.map(line => line.trim().split(/\s+/u)[0])).deepEqual([...LANE_CATEGORIES]);
    should(categoryLines[0]).equal('  backlog not started yet');
  });

  it('should send a reader to the project lanes, name what moves a card itself and say blocked is not a lane', () => {
    // Act
    const text = laneGuide('fy');

    // Assert
    should(text).containEql('`fy board lanes show` lists this project\'s lanes with "use when"');
    should(text).containEql('the owner approves leaving it');
    should(text).containEql('A start, a PR, a merge, a release and `fy signal done` move a card by themselves');
    should(text).containEql('Blocked is not a lane: `fy task block`, `fy task depend` or `fy agenda add --task <id>`.');
  });

  it('should take the binary name from the caller, never a hard-coded one', () => {
    // Assert
    should(laneGuide('ferret')).containEql('`ferret board lanes show`').and.not.containEql('`fy ');
  });
});
