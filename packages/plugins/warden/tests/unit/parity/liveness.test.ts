import { describe, it } from 'bun:test';
import should from 'should';
import { fakeBrowsers } from '@ferretry/plugin-browsers/contract/testing';
import type { LivenessSample } from '@ferretry/plugin-terminals/contract';
import { FERRET, livenessHost } from './liveness-host.ts';

/** A harness's live status line, its elapsed clock climbing a tick at a time while its token counter stays flat. */
const thinking = (look: number): LivenessSample => {
  const elapsed = look * 30;
  const pane = `✢ Thinking… (${Math.floor(elapsed / 60)}m ${elapsed % 60}s · ↓ 1.2k tokens)`;
  return { pane, paneHash: `screen-${look}`, subprocessAlive: false };
};
const stuckCommand: LivenessSample = {
  pane: 'Running bun test…',
  paneHash: 'same',
  subprocessAlive: true,
  subprocessKey: 'pid:600',
};
const stillScreen: LivenessSample = { pane: '❯ ', paneHash: 'same', subprocessAlive: false };
const leftover: LivenessSample = { pane: '❯ ', paneHash: 'same', subprocessAlive: false, leftoverBrowser: true };

describe('the Warden flags what the liveness monitor sees through Terminals (today’s sweep)', () => {
  it('should flag dead_monitor for a working ferret the monitor cannot see (no screen, no transcript)', async () => {
    // Arrange
    const host = livenessHost({ transcript: 'unreadable' });
    const disarm = host.arm();

    // Act
    await host.ticks(8);
    const kinds = await host.sweep();
    disarm();

    // Assert
    should(kinds).containEql('dead_monitor');
  });

  it('should not run the liveness checks while Terminals is off: Ferrets’ own account stands in, no dead_monitor', async () => {
    // Arrange
    const host = livenessHost({ transcript: 'unreadable', terminalsOff: true });
    const disarm = host.arm();

    // Act
    await host.ticks(8);
    const kinds = await host.sweep();
    disarm();

    // Assert
    should(host.looks()).equal(0);
    should(kinds).not.containEql('dead_monitor');
  });

  it('should flag sus_thinking when the work clock climbs, tokens stay flat and the transcript has not grown', async () => {
    // Arrange
    const host = livenessHost({ sample: thinking });
    const disarm = host.arm();

    // Act: sixteen and a half minutes, past today's 900 s default.
    await host.ticks(33);
    const kinds = await host.sweep();
    disarm();

    // Assert
    should(kinds).containEql('sus_thinking');
    should(kinds).not.containEql('dead_monitor');
  });

  it('should flag sus_subprocess when one tool command has run with nothing moving for ten minutes', async () => {
    // Arrange
    const host = livenessHost({ sample: () => stuckCommand });
    const disarm = host.arm();

    // Act
    await host.ticks(24);
    const kinds = await host.sweep();
    disarm();

    // Assert
    should(kinds).containEql('sus_subprocess');
  });

  it('should flag agent_frozen after the reflex nudged a ferret showing no sign of life, and nudge it once', async () => {
    // Arrange
    const host = livenessHost({ sample: () => stillScreen });
    const disarm = host.arm();

    // Act
    await host.ticks(34);
    const kinds = await host.sweep();
    const sent = (await host.conversation.sends(FERRET)).sends;
    disarm();

    // Assert
    should(kinds).containEql('agent_frozen');
    should(sent.length).equal(1);
  });

  it('should raise none of the liveness flags while Terminals is off, however still the ferret is', async () => {
    // Arrange
    const host = livenessHost({ sample: () => stillScreen, terminalsOff: true });
    const disarm = host.arm();

    // Act
    await host.ticks(34);
    const kinds = await host.sweep();
    disarm();

    // Assert
    for (const kind of ['dead_monitor', 'sus_thinking', 'sus_subprocess', 'agent_frozen'])
      should(kinds).not.containEql(kind);
  });
});

describe('the Warden closes a browser left under a ferret’s pane (today’s remedy, behind mayActAlone.closeLeftovers)', () => {
  it('should close it through Browsers once its turn has ended and ten minutes passed, when the owner allows it', async () => {
    // Arrange
    const browsers = fakeBrowsers({}, undefined, { f1: 1 });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    disarm();

    // Assert
    should(browsers.closed).containEql(FERRET);
    should(actions.map(action => action.outcome)).containEql('done');
  });

  it('should never close it when the owner has not let the Warden close leftovers alone: it is held, and said', async () => {
    // Arrange
    const browsers = fakeBrowsers({}, undefined, { f1: 1 });
    const host = livenessHost({
      state: 'idle',
      sample: () => leftover,
      browsers,
      config: { mayActAlone: { closeLeftovers: false } },
    });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    disarm();

    // Assert
    should(browsers.closed).eql([]);
    should(actions.map(action => action.outcome)).eql(['held']);
  });

  it('should not run the leftover check at all while Browsers is off', async () => {
    // Arrange
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers: 'off' });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    disarm();

    // Assert
    should(actions).eql([]);
  });

  it('should close nothing before the ten-minute grace has passed', async () => {
    // Arrange
    const browsers = fakeBrowsers({}, undefined, { f1: 1 });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(10);
    await host.sweep();
    disarm();

    // Assert
    should(browsers.closed).eql([]);
  });
});
