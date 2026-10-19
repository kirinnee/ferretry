import { describe, it } from 'bun:test';
import should from 'should';
import { DaemonUpdateStatusReader, nextStep, renderUpdateStatus } from '../../../src/lib/update/status';
import { FakeFacts, FakeUpdateView } from './fixtures';

const daemon = { path: '/opt/homebrew/bin/fyd', source: 'PATH' as const, version: '1.2.3' };

describe('DaemonUpdateStatusReader', () => {
  it('classifies the installed daemon and asks the serving one about updates', async () => {
    const view = new FakeUpdateView([0]);
    const status = await new DaemonUpdateStatusReader(new FakeFacts('homebrew'), view).read(daemon, true);
    should(status.install).deepEqual({ kind: 'homebrew', cask: 'ferretry' });
    should(status.update?.available).be.true();
  });

  it('asks nothing it cannot answer', async () => {
    const view = new FakeUpdateView([0]);
    const status = await new DaemonUpdateStatusReader(new FakeFacts('homebrew'), view).read(undefined, false);
    should(status).deepEqual({ install: undefined, update: undefined });
    should(view.looks).equal(0);
  });
});

describe('renderUpdateStatus', () => {
  it('names the method and the available update with the one next step', async () => {
    const update = await new FakeUpdateView([0]).view();
    should(renderUpdateStatus({ install: { kind: 'homebrew', cask: 'ferretry' }, update }, 'fy')).deepEqual([
      '  installed via Homebrew cask ferretry',
      '  update available 1.2.3 → 1.3.0 (https://github.com/kirinnee/ferretry/releases/tag/v1.3.0)',
      '  to update: fy daemon update',
    ]);
  });

  it('says nothing about an update that is not available', async () => {
    const update = await new FakeUpdateView([0]).view();
    should(
      renderUpdateStatus({ install: undefined, update: update && { ...update, available: false } }, 'fy'),
    ).deepEqual([]);
    should(
      renderUpdateStatus({ install: undefined, update: update && { ...update, check: { state: 'never' } } }, 'fy'),
    ).deepEqual([]);
  });

  it('names the first step of a plan it cannot run itself', () => {
    should(
      nextStep({ kind: 'manual', explanation: 'why', steps: [{ command: 'sudo apt-get upgrade fy' }] }, 'fy'),
    ).equal('sudo apt-get upgrade fy');
    should(nextStep({ kind: 'manual', explanation: 'nothing to do', steps: [] }, 'fy')).equal('nothing to do');
  });
});
