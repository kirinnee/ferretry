import { describe, it } from 'bun:test';
import should from 'should';
import { fakeBrowsers } from '@ferretry/plugin-browsers/contract/testing';
import { LeftAloneWhySchema } from '@ferretry/plugin-browsers/contract';
import type { LivenessSample } from '@ferretry/plugin-terminals/contract';
import { FERRET, livenessHost } from './liveness-host.ts';
import { WardenLeftAloneWhySchema } from '../../../contract/index.ts';

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

  it('should flag agent_frozen, and nudge NOBODY, for a quiet auto ferret on the 5.0 subsystem (detection only)', async () => {
    // Arrange: the reviewer's case — a quiet auto ferret past five minutes. FerretSummary carries neither a declared
    // wait nor its own --nudge-after, so the 5.0 reflex may not type to it at all.
    const host = livenessHost({ sample: () => stillScreen });
    const disarm = host.arm();

    // Act
    await host.ticks(12);
    const afterFive = (await host.conversation.sends(FERRET)).sends.length;
    await host.ticks(22);
    const kinds = await host.sweep();
    const sent = (await host.conversation.sends(FERRET)).sends;
    const nudges = (await host.subsystem.status()).actions.filter(action => action.action === 'nudge');
    disarm();

    // Assert
    should(afterFive).equal(0);
    should(kinds).containEql('agent_frozen');
    should(sent).eql([]);
    should(nudges).eql([]);
  });

  it('should flag agent_frozen after the reflex nudged a ferret showing no sign of life, and nudge it once (reflex nudges on)', async () => {
    // Arrange: today's act, with the setting the 5.0 daemon leaves off turned on.
    const host = livenessHost({ sample: () => stillScreen, reflexNudges: true });
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
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 1, leftAlone: [] } });
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
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 1, leftAlone: [] } });
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

  it('should record the pids a close left alone, with why, in its action and its WardenActed event', async () => {
    // Arrange: one browser closed, one Browsers could not prove (its pid now another process's).
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 1, leftAlone: [{ pid: 905, why: 'not-proved' }] } });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    const acted = host.published.filter(event => event.event === 'warden.acted');
    disarm();

    // Assert: every sweep that closed one says so (each sweep re-reads the pane), naming what it left alone.
    should(actions.length).be.above(0);
    for (const action of actions) {
      should(action.outcome).equal('done');
      should(action.detail).match(/Left alone: pid 905 \(not proved\)\./u);
    }
    should(acted.length).equal(actions.length);
    for (const event of acted)
      should(event.payload).eql({
        ferret: FERRET,
        action: 'close_leftover',
        outcome: 'done',
        leftAlone: [{ pid: 905, why: 'not-proved' }],
      });
  });

  it('should record a failed close only when every browser it proved refused the signal, naming them', async () => {
    // Arrange
    const browsers = fakeBrowsers({}, undefined, {
      f1: { closed: 0, leftAlone: [{ pid: 701, why: 'signal-refused' }] },
    });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    const acted = host.published.filter(event => event.event === 'warden.acted');
    disarm();

    // Assert: said once per leftover in the actions; every attempt is told in the event.
    should(actions.map(action => action.outcome)).eql(['failed']);
    should(actions[0]?.detail).match(/the signal was refused\. Left alone: pid 701 \(signal refused\)\./u);
    should(acted.length).be.above(0);
    for (const event of acted)
      should(event.payload).eql({
        ferret: FERRET,
        action: 'close_leftover',
        outcome: 'failed',
        leftAlone: [{ pid: 701, why: 'signal-refused' }],
      });
  });

  it('should record no close at all when nothing it could prove was closed or refused (only left alone)', async () => {
    // Arrange: the browser exited before its re-proof.
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 0, leftAlone: [{ pid: 701, why: 'gone' }] } });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    const acted = host.published.filter(event => event.event === 'warden.acted');
    disarm();

    // Assert: a race with the browser is not an ownership question, so it is the journal line only.
    should(browsers.closed).containEql(FERRET);
    should(actions).eql([]);
    should(acted).eql([]);
    should(host.logged).containEql('fleet.warden_leftover_left_alone');
  });

  it('should show the owner a pid it left alone as not proved, when nothing else happened (one held row, one held event)', async () => {
    // Arrange: nothing closed, nothing refused; the pid now names another process.
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 0, leftAlone: [{ pid: 905, why: 'not-proved' }] } });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    const acted = host.published.filter(event => event.event === 'warden.acted');
    disarm();

    // Assert: said once per leftover in the actions; the journal line is kept.
    should(actions.map(action => action.outcome)).eql(['held']);
    should(actions[0]?.detail).match(/Left alone: pid 905 \(not proved\)\./u);
    should(acted.length).be.above(0);
    for (const event of acted)
      should(event.payload).eql({
        ferret: FERRET,
        action: 'close_leftover',
        outcome: 'held',
        leftAlone: [{ pid: 905, why: 'not-proved' }],
      });
    should(host.logged).containEql('fleet.warden_leftover_left_alone');
  });

  it('should show the owner a pid it left alone as invalid, when nothing else happened', async () => {
    // Arrange
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 0, leftAlone: [{ pid: -1, why: 'invalid-pid' }] } });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    const acted = host.published.filter(event => event.event === 'warden.acted');
    disarm();

    // Assert
    should(actions.map(action => action.outcome)).eql(['held']);
    should(acted.map(event => (event.payload as { outcome: string }).outcome)).containEql('held');
  });

  it('should not show tool-running alone to the owner either (journal only)', async () => {
    // Arrange
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 0, leftAlone: [{ pid: 701, why: 'tool-running' }] } });
    const host = livenessHost({ state: 'idle', sample: () => leftover, browsers });
    const disarm = host.arm();

    // Act
    await host.ticks(22);
    await host.sweep();
    const actions = (await host.subsystem.status()).actions.filter(action => action.action === 'close_leftover');
    const acted = host.published.filter(event => event.event === 'warden.acted');
    disarm();

    // Assert
    should(actions).eql([]);
    should(acted).eql([]);
    should(host.logged).containEql('fleet.warden_leftover_left_alone');
  });

  it('should close nothing before the ten-minute grace has passed', async () => {
    // Arrange
    const browsers = fakeBrowsers({}, undefined, { f1: { closed: 1, leftAlone: [] } });
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

describe('the reasons a WardenActed event gives for a browser left alone', () => {
  it('should be exactly Browsers’ own closed set (Browsers owns the words; the contract spells them again)', () => {
    should([...WardenLeftAloneWhySchema.options].sort()).eql([...LeftAloneWhySchema.options].sort());
  });
});
