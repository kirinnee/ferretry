/**
 * The step-up gate: one prompt per machine however many requests wait, a ceremony that starts only on
 * the button, and a settled prompt that hands the screen to the next machine.
 */

import { describe, it } from 'bun:test';
import type { StepUpAct, TwoFactorStageId } from '@ferretry/protocol';
import should from 'should';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { STEP_UP_FALLBACK_ACT as FALLBACK } from '../../src/lib/grants.ts';
import { StepUpGate } from '../../src/lib/step-up-gate.ts';

const machine = (name: string): DaemonConnection =>
  daemonConnection({ daemonId: `daemon-${name}`, baseUrl: `https://${name}.example`, deviceId: 'device-one' });

const first = machine('first');
const second = machine('second');

/** A ceremony the test settles by hand, so "busy" is an observable state rather than a race. */
function manualCeremony() {
  const calls: DaemonConnection[] = [];
  const pending: { resolve: () => void; reject: (reason: unknown) => void }[] = [];
  const ceremony = (daemon: DaemonConnection): Promise<void> => {
    calls.push(daemon);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { calls, pending, ceremony };
}

const gateWith = (ceremony: (daemon: DaemonConnection, act?: StepUpAct) => Promise<void>) =>
  new StepUpGate({ ceremony, describe: reason => `described: ${String(reason)}` });

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('asking for a step-up', () => {
  it('should open nothing until a request asks', () => {
    // Arrange, Act
    const gate = gateWith(async () => undefined);

    // Assert
    should(gate.snapshot()).be.null();
  });

  it('should open ONE prompt for a machine however many requests wait on it', async () => {
    // Arrange
    const { ceremony, calls, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    const answers: boolean[] = [];
    let changes = 0;
    gate.subscribe(() => {
      changes += 1;
    });

    // Act
    const waiting = [gate.require(first), gate.require(first), gate.require(first)].map(async wait => {
      answers.push(await wait);
    });
    await flush();

    // Assert — one prompt, nobody resolved, no ceremony started by itself.
    should(changes).equal(1);
    should(gate.snapshot()).eql({ daemon: first, acts: [FALLBACK], busy: false });
    should(answers).eql([]);
    should(calls).eql([]);

    // Act — the button runs one ceremony and settles all three.
    const confirming = gate.confirm();
    pending[0]?.resolve();
    await confirming;
    await Promise.all(waiting);

    // Assert
    should(calls).eql([first]);
    should(answers).eql([true, true, true]);
    should(gate.snapshot()).be.null();
  });
});

describe('stamping the proof with the act', () => {
  const acts = () => {
    const stamped: (StepUpAct | undefined)[] = [];
    const gate = gateWith(async (_daemon, act) => {
      stamped.push(act);
    });
    return { gate, stamped };
  };

  it('should run the ceremony for the one act every waiting request named', async () => {
    // Arrange
    const { gate, stamped } = acts();
    const waiting = [
      gate.require(first, 'install a catalog item', 'explicit', 'catalog-install'),
      gate.require(first, 'install a catalog item', 'explicit', 'catalog-install'),
    ];

    // Act
    await gate.confirm();
    await Promise.all(waiting);

    // Assert
    should(stamped).eql(['catalog-install']);
  });

  it('should leave the proof unstamped when a request named no act, or several acts share the prompt', async () => {
    // Arrange
    const unnamed = acts();
    const named = unnamed.gate.require(first, 'install a catalog item', 'explicit', 'catalog-install');
    const other = unnamed.gate.require(first);
    const mixed = acts();
    const one = mixed.gate.require(first, 'install a catalog item', 'explicit', 'catalog-install');
    const two = mixed.gate.require(first, 'loosen a file', 'explicit', 'loosen-config');

    // Act
    await unnamed.gate.confirm();
    await mixed.gate.confirm();
    await Promise.all([named, other, one, two]);

    // Assert
    should(unnamed.stamped).eql([undefined]);
    should(mixed.stamped).eql([undefined]);
  });
});

describe('binding the proof to one staged key', () => {
  const STAGE_ONE = `st_${'1'.repeat(24)}` as TwoFactorStageId;
  const STAGE_TWO = `st_${'2'.repeat(24)}` as TwoFactorStageId;
  const subjects = () => {
    const stamped: { act?: StepUpAct; subject?: TwoFactorStageId }[] = [];
    const gate = new StepUpGate({
      ceremony: async (_daemon, act, subject) => {
        stamped.push({ act, subject });
      },
      describe: reason => `described: ${String(reason)}`,
    });
    return { gate, stamped };
  };

  it('should run the ceremony for the one staged key every waiting request named', async () => {
    // Arrange
    const { gate, stamped } = subjects();
    const waiting = gate.require(first, 'save codes', 'explicit', 'add-2fa-key', STAGE_ONE);

    // Act
    await gate.confirm();
    await waiting;

    // Assert
    should(stamped).eql([{ act: 'add-2fa-key', subject: STAGE_ONE }]);
  });

  it('should leave the proof unstamped when two staged keys share the prompt, so neither is saved by it', async () => {
    // Arrange
    const { gate, stamped } = subjects();
    const one = gate.require(first, 'save codes', 'explicit', 'add-2fa-key', STAGE_ONE);
    const two = gate.require(first, 'save codes', 'explicit', 'add-2fa-key', STAGE_TWO);

    // Act
    await gate.confirm();
    await Promise.all([one, two]);

    // Assert
    should(stamped).eql([{ act: undefined, subject: undefined }]);
  });
});

describe('confirming', () => {
  it('should be busy while the ceremony runs, then resolve every waiter true and close', async () => {
    // Arrange
    const { ceremony, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    const one = gate.require(first);
    const two = gate.require(first);

    // Act
    const confirming = gate.confirm();

    // Assert — the prompt says so while the passkey sheet is up.
    should(gate.snapshot()).eql({ daemon: first, acts: [FALLBACK], busy: true });
    pending[0]?.resolve();
    await confirming;
    should(await one).be.true();
    should(await two).be.true();
    should(gate.snapshot()).be.null();
  });

  it('should keep the prompt, say why and stop being busy when the ceremony fails', async () => {
    // Arrange
    const { ceremony, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    let settled: boolean | undefined;
    const waiting = gate.require(first).then(answer => {
      settled = answer;
    });

    // Act
    const confirming = gate.confirm();
    pending[0]?.reject(new Error('sheet closed'));
    await confirming;
    await flush();

    // Assert — the request still waits; the person can try again.
    should(gate.snapshot()).eql({
      daemon: first,
      acts: [FALLBACK],
      busy: false,
      failure: 'described: Error: sheet closed',
    });
    should(settled).be.undefined();

    // Act — a second try that works clears the failure and resolves the waiter.
    const retrying = gate.confirm();
    should(gate.snapshot()).eql({ daemon: first, acts: [FALLBACK], busy: true });
    pending[1]?.resolve();
    await retrying;
    await waiting;
    should(settled).be.true();
    should(gate.snapshot()).be.null();
  });

  it('should do nothing with no prompt, and nothing while a ceremony is already running', async () => {
    // Arrange
    const { ceremony, calls, pending } = manualCeremony();
    const gate = gateWith(ceremony);

    // Act, Assert — no prompt.
    await gate.confirm();
    should(calls).eql([]);

    // Act — a second tap while busy.
    const waiting = gate.require(first);
    const confirming = gate.confirm();
    await gate.confirm();

    // Assert
    should(calls).have.length(1);
    pending[0]?.resolve();
    await confirming;
    await waiting;
  });
});

describe('dismissing', () => {
  it('should resolve every waiter on the machine false and close', async () => {
    // Arrange
    const gate = gateWith(async () => undefined);
    const one = gate.require(first);
    const two = gate.require(first);

    // Act
    gate.dismiss();

    // Assert
    should(await one).be.false();
    should(await two).be.false();
    should(gate.snapshot()).be.null();
  });

  it('should do nothing with no prompt', () => {
    // Arrange
    const gate = gateWith(async () => undefined);
    let changes = 0;
    gate.subscribe(() => {
      changes += 1;
    });

    // Act
    gate.dismiss();

    // Assert
    should(changes).equal(0);
  });

  it('should do nothing while a ceremony is running', async () => {
    // Arrange
    const { ceremony, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    let answer: boolean | undefined;
    const waiting = gate.require(first).then(value => {
      answer = value;
    });
    const confirming = gate.confirm();

    // Act
    gate.dismiss();
    await flush();

    // Assert — still busy, nobody resolved.
    should(gate.snapshot()).eql({ daemon: first, acts: [FALLBACK], busy: true });
    should(answer).be.undefined();
    pending[0]?.resolve();
    await confirming;
    await waiting;
    should(answer).be.true();
  });
});

describe('two machines asking', () => {
  it('should queue the second and show it once the first settles', async () => {
    // Arrange
    const { ceremony, calls, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    const answers: Record<string, boolean> = {};
    const waitingFirst = gate.require(first).then(value => {
      answers.first = value;
    });
    const waitingSecond = gate.require(second).then(value => {
      answers.second = value;
    });

    // Assert — only the first is on screen.
    should(gate.snapshot()).eql({ daemon: first, acts: [FALLBACK], busy: false });

    // Act — the first is confirmed.
    const confirming = gate.confirm();
    pending[0]?.resolve();
    await confirming;
    await waitingFirst;

    // Assert — the second takes the screen, unsettled and not busy.
    should(answers).eql({ first: true });
    should(gate.snapshot()).eql({ daemon: second, acts: [FALLBACK], busy: false });

    // Act — the second is dismissed.
    gate.dismiss();
    await waitingSecond;

    // Assert
    should(answers).eql({ first: true, second: false });
    should(calls).eql([first]);
    should(gate.snapshot()).be.null();
  });
});

describe('watching the gate', () => {
  it('should tell a subscriber about each change until it unsubscribes', () => {
    // Arrange
    const gate = gateWith(async () => undefined);
    let changes = 0;
    const stop = gate.subscribe(() => {
      changes += 1;
    });

    // Act
    void gate.require(first);
    should(changes).equal(1);
    stop();
    gate.dismiss();

    // Assert — the dismissal changed the prompt, and nobody was told.
    should(changes).equal(1);
    should(gate.snapshot()).be.null();
  });

  it('should hand back the same snapshot object until something changes', () => {
    // Arrange
    const gate = gateWith(async () => undefined);
    void gate.require(first);

    // Act, Assert — `useSyncExternalStore` needs stability between changes.
    should(gate.snapshot()).equal(gate.snapshot());
  });
});

describe('naming the act', () => {
  it('should keep the act a request named, and fall back to "make this change" when it named none', () => {
    // Arrange
    const named = gateWith(async () => undefined);
    const unnamed = gateWith(async () => undefined);

    // Act
    void named.require(first, 'open a terminal');
    void unnamed.require(first);

    // Assert
    should(named.snapshot()?.acts).eql(['open a terminal']);
    should(unnamed.snapshot()?.acts).eql([FALLBACK]);
    should(FALLBACK).equal('make this change');
  });

  it('should add each distinct act of one machine to the one prompt, once, keeping its state', async () => {
    // Arrange
    const { ceremony, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    let changes = 0;
    gate.subscribe(() => {
      changes += 1;
    });
    void gate.require(first, 'open a terminal');
    void gate.confirm();
    await flush();
    changes = 0;

    // Act — a second request, then the same act again.
    void gate.require(first, 'open the remote browser');
    void gate.require(first, 'open the remote browser');
    void gate.require(first, 'open a terminal');

    // Assert — one prompt, both acts once, and it is still busy.
    should(gate.snapshot()).eql({ daemon: first, acts: ['open a terminal', 'open the remote browser'], busy: true });
    should(changes).equal(1);
    pending[0]?.resolve();
  });

  it('should show a queued machine its own acts, not the first machine’s', async () => {
    // Arrange
    const { ceremony, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    void gate.require(first, 'open a terminal');
    void gate.require(second, 'run a command with a stored secret');
    void gate.require(second, 'open a terminal');

    // Act — the first machine is confirmed.
    const confirming = gate.confirm();
    pending[0]?.resolve();
    await confirming;

    // Assert
    should(gate.snapshot()).eql({
      daemon: second,
      acts: ['run a command with a stored secret', 'open a terminal'],
      busy: false,
    });
  });

  it('should not touch the prompt when an act joins a machine that is waiting but not on screen', () => {
    // Arrange
    const gate = gateWith(async () => undefined);
    void gate.require(first, 'open a terminal');
    void gate.require(second, 'open the remote browser');
    const before = gate.snapshot();

    // Act
    void gate.require(second, 'open a terminal');

    // Assert — the screen still shows the first machine, unchanged.
    should(gate.snapshot()).equal(before);
  });
});

describe('what a confirmation buys, read when the prompt opens', () => {
  const withScope = (scope: (daemon: DaemonConnection) => Promise<string>, ceremony = manualCeremony().ceremony) =>
    new StepUpGate({ ceremony, describe: reason => `described: ${String(reason)}`, scope });

  it('should read it once for the prompt on screen and keep it through busy and a failure', async () => {
    const { ceremony, pending } = manualCeremony();
    const reads: string[] = [];
    const gate = withScope(async daemon => {
      reads.push(daemon.daemonId);
      return 'It stays unlocked for 8 hours.';
    }, ceremony);

    void gate.require(first);
    should(gate.snapshot()?.scope).be.undefined();
    await flush();
    should(gate.snapshot()?.scope).equal('It stays unlocked for 8 hours.');
    void gate.confirm();
    should(gate.snapshot()?.scope).equal('It stays unlocked for 8 hours.');
    pending[0]?.reject(new Error('no'));
    await flush();

    should(gate.snapshot()?.failure).equal('described: Error: no');
    should(gate.snapshot()?.scope).equal('It stays unlocked for 8 hours.');
    should(reads).eql(['daemon-first']);
  });

  it('should leave the prompt without a scope when the read fails, and never block the confirmation on it', async () => {
    const { ceremony, pending } = manualCeremony();
    const gate = withScope(async () => {
      throw new Error('offline');
    }, ceremony);

    const answer = gate.require(first);
    await flush();
    should(gate.snapshot()?.scope).be.undefined();
    void gate.confirm();
    pending[0]?.resolve();

    should(await answer).be.true();
  });

  it('should drop a read that lands after the prompt was dismissed', async () => {
    let release: (scope: string) => void = () => undefined;
    const gate = withScope(() => new Promise<string>(resolve => (release = resolve)));

    void gate.require(first);
    gate.dismiss();
    release('late');
    await flush();

    should(gate.snapshot()).be.null();
  });
});

describe('a device that may add its first passkey, read when the prompt opens', () => {
  it('should mark the prompt so it leads with setting one up, and say nothing when the read fails', async () => {
    // Arrange
    const offered = new StepUpGate({
      ceremony: manualCeremony().ceremony,
      describe: String,
      firstPasskey: async () => true,
    });
    const unknown = new StepUpGate({
      ceremony: manualCeremony().ceremony,
      describe: String,
      firstPasskey: async () => {
        throw new Error('offline');
      },
    });

    // Act
    void offered.require(first);
    void unknown.require(first);
    await flush();

    // Assert
    should(offered.snapshot()?.firstPasskey).be.true();
    should(unknown.snapshot()?.firstPasskey).be.undefined();
  });
});

describe('a prompt comes from the machine on screen', () => {
  it('should hold a background request for a machine off screen, list it, and ask once it comes on screen', async () => {
    // Arrange — B19: with two machines paired, a locked second machine's background read raised its
    // prompt over the first machine's page.
    const gate = gateWith(async () => undefined);
    gate.focus(first.daemonId);
    const answers: boolean[] = [];

    // Act
    const waiting = gate.require(second, FALLBACK, 'background').then(answer => answers.push(answer));
    const held = gate.snapshot();
    const listed = gate.waitingDaemons();
    gate.focus(second.daemonId);
    const shown = gate.snapshot()?.daemon;
    await gate.confirm();
    await waiting;

    // Assert
    should(held).be.null();
    should(listed).deepEqual([second.daemonId]);
    should(shown).equal(second);
    should(answers).deepEqual([true]);
    should(gate.waitingDaemons()).have.length(0);
  });

  it('should ask at once for the machine on screen, and for a request a person started anywhere', () => {
    // Arrange
    const onScreen = gateWith(async () => undefined);
    onScreen.focus(first.daemonId);
    const pressed = gateWith(async () => undefined);
    pressed.focus(first.daemonId);

    // Act
    void onScreen.require(first, FALLBACK, 'background');
    void pressed.require(second);

    // Assert
    should(onScreen.snapshot()?.daemon).equal(first);
    should(pressed.snapshot()?.daemon).equal(second);
  });

  it('should open a held machine when a person starts a request on it, and pass over it to the next', async () => {
    // Arrange
    const gate = gateWith(async () => undefined);
    gate.focus(first.daemonId);
    void gate.require(second, FALLBACK, 'background');
    void gate.require(first, FALLBACK, 'background');

    // Act — the machine on screen asks first; the held one is not shown when it settles.
    const before = gate.snapshot()?.daemon;
    gate.dismiss();
    const afterSettle = gate.snapshot();
    void gate.require(second, 'open a terminal');

    // Assert
    should(before).equal(first);
    should(afterSettle).be.null();
    should(gate.snapshot()?.daemon).equal(second);
    should(gate.snapshot()?.acts).deepEqual([FALLBACK, 'open a terminal']);
  });

  it('should send a background prompt back to waiting when its machine leaves the screen, unless it is being answered', async () => {
    // Arrange
    const { ceremony, pending } = manualCeremony();
    const gate = gateWith(ceremony);
    gate.focus(first.daemonId);
    void gate.require(first, FALLBACK, 'background');
    const busy = gateWith(ceremony);
    busy.focus(first.daemonId);
    void busy.require(first, FALLBACK, 'background');
    const confirming = busy.confirm();

    // Act
    gate.focus(second.daemonId);
    busy.focus(second.daemonId);
    const left = gate.snapshot();
    const answering = busy.snapshot()?.busy;
    gate.focus(first.daemonId);
    gate.focus(first.daemonId);

    // Assert
    should(left).be.null();
    should(gate.waitingDaemons()).deepEqual([first.daemonId]);
    should(answering).be.true();
    should(gate.snapshot()?.daemon).equal(first);
    pending[0]?.resolve();
    await confirming;
  });

  it('should keep what one machine said off another machine’s prompt', async () => {
    // Arrange
    const reads: ((scope: string) => void)[] = [];
    const gate = new StepUpGate({
      ceremony: async () => undefined,
      describe: String,
      scope: () => new Promise<string>(resolve => reads.push(resolve)),
    });
    gate.focus(second.daemonId);
    void gate.require(second, FALLBACK, 'background');
    gate.focus(first.daemonId);
    void gate.require(first);

    // Act — the held machine's read lands while the other machine's prompt is on screen.
    reads[0]?.('for the held machine');
    await flush();

    // Assert
    should(gate.snapshot()?.daemon).equal(first);
    should(gate.snapshot()?.scope).be.undefined();
  });
});
