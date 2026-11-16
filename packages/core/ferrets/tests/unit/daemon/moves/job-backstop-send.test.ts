import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretHarness } from '../../../../contract/port.ts';
import { bindBackstopAsk } from '../../../../daemon/lib/moves/job-backstop-send.ts';

const held = {} as FerretHarness;
const message = { id: 'job-ended-abc', text: 'job build (abc) ended with 0; `fy job logs abc`' };

describe('binding the completion backstop to the monitor send', () => {
  it('should send the job message under the job id and answer that it was sent', async () => {
    const sends: unknown[] = [];
    const ask = bindBackstopAsk(async () => held, { send: async request => void sends.push(request) });

    should(await ask('ferret-a', message)).be.true();
    should(sends).deepEqual([{ id: 'ferret-a', sendId: 'job-ended-abc', message: message.text }]);
  });

  it('should skip a ferret that is not held, without sending', async () => {
    const sends: unknown[] = [];
    const ask = bindBackstopAsk(async () => undefined, { send: async request => void sends.push(request) });

    should(await ask('ferret-a', message)).equal('not-held');
    should(sends).deepEqual([]);
  });

  it('should let a refused send throw, so the pass logs it and leaves the job untold', async () => {
    const ask = bindBackstopAsk(async () => held, {
      send: async () => {
        throw new Error('the wake was not typed: dialog');
      },
    });

    await should(ask('ferret-a', message)).be.rejectedWith(/not typed/u);
  });
});
