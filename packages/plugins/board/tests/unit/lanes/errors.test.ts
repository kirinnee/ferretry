import { describe, it } from 'bun:test';
import should from 'should';
import {
  BOARD_SWITCH_UNAVAILABLE_MESSAGE,
  BoardSwitchUnavailableError,
  LANE_SET_UNAVAILABLE_MESSAGE,
  LaneSetUnavailableError,
} from '../../../daemon/lib/lanes/errors.ts';

describe('the refusals for a damaged lane document', () => {
  it('should tell a caller the fixed words and keep the evidence for the daemon', () => {
    const error = new LaneSetUnavailableError('/state/lanes.json: bad json');
    should(error.message).equal(LANE_SET_UNAVAILABLE_MESSAGE);
    should(error.message).not.containEql('/state');
    should(error).match({
      code: 'unavailable',
      detail: '/state/lanes.json: bad json',
      name: 'LaneSetUnavailableError',
    });
  });

  it('should do the same for a damaged board switch', () => {
    const error = new BoardSwitchUnavailableError('/state/switch.json: bad json');
    should(error.message).equal(BOARD_SWITCH_UNAVAILABLE_MESSAGE);
    should(error).match({
      code: 'unavailable',
      detail: '/state/switch.json: bad json',
      name: 'BoardSwitchUnavailableError',
    });
  });
});
