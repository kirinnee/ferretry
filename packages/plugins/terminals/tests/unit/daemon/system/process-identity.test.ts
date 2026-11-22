import { describe, it } from 'bun:test';
import should from 'should';
import {
  hostProcessReader,
  identify,
  namesSocket,
  parseProcStat,
  signalVerified,
  stillRunning,
  type ProcessFacts,
  type ProcessIdentity,
} from '../../../support/daemon/process-identity.ts';

/**
 * The fixture that ends a test's tmux server may only signal a process that is still the one it recorded. A fake
 * process table stands in for `/proc`, and the signal sender is a recorder: no test here signals anything.
 */
const SOCKET = '/tmp/fyt.abc/s';
const SERVER: ProcessFacts = { start: '1000', argv: ['tmux', '-u', '-S', SOCKET, 'new-session'], defunct: false };

const table =
  (entries: Readonly<Record<number, ProcessFacts>>) =>
  (pid: number): ProcessFacts | undefined =>
    entries[pid];

class Signals {
  readonly sent: [number, string][] = [];
  readonly send = (pid: number, signal: string): void => {
    this.sent.push([pid, signal]);
  };
}

const recorded: ProcessIdentity = { pid: 4242, start: '1000' };

describe('signalling a recorded process', () => {
  it('should signal a pid that still carries the recorded start time and names the private socket', () => {
    // Arrange
    const signals = new Signals();

    // Act
    const sent = signalVerified(recorded, SOCKET, 'SIGKILL', { read: table({ 4242: SERVER }), send: signals.send });

    // Assert
    should(sent).be.true();
    should(signals.sent).deepEqual([[4242, 'SIGKILL']]);
  });

  it('should NOT signal a pid reused by another process (a different start time), even one naming the same socket', () => {
    // Arrange
    const signals = new Signals();
    const reused = { ...SERVER, start: '9999' };

    // Act
    const sent = signalVerified(recorded, SOCKET, 'SIGKILL', { read: table({ 4242: reused }), send: signals.send });

    // Assert
    should(sent).be.false();
    should(signals.sent).deepEqual([]);
  });

  it('should NOT signal a pid whose command line does not name the private socket, even at the recorded start time', () => {
    // Arrange — a live agent's own tmux server, which any same-user pid reuse could land on.
    const signals = new Signals();
    const agents = { ...SERVER, argv: ['tmux', '-u', '-S', '/run/user/1000/fy/agents.sock', 'attach'] };
    const other = { ...SERVER, argv: ['sleep', '30'] };

    // Act
    const first = signalVerified(recorded, SOCKET, 'SIGKILL', { read: table({ 4242: agents }), send: signals.send });
    const second = signalVerified(recorded, SOCKET, 'SIGKILL', { read: table({ 4242: other }), send: signals.send });

    // Assert
    should([first, second]).deepEqual([false, false]);
    should(signals.sent).deepEqual([]);
  });

  it('should NOT signal a pid that is gone or only waits to be reaped', () => {
    // Arrange
    const signals = new Signals();

    // Act
    const gone = signalVerified(recorded, SOCKET, 'SIGKILL', { read: table({}), send: signals.send });
    const defunct = signalVerified(recorded, SOCKET, 'SIGKILL', {
      read: table({ 4242: { ...SERVER, defunct: true } }),
      send: signals.send,
    });

    // Assert
    should([gone, defunct]).deepEqual([false, false]);
    should(signals.sent).deepEqual([]);
  });

  it('should answer false when the process ended between the check and the signal', () => {
    // Arrange
    const send = (): void => {
      throw new Error('ESRCH');
    };

    // Act
    const sent = signalVerified(recorded, SOCKET, 'SIGKILL', { read: table({ 4242: SERVER }), send });

    // Assert
    should(sent).be.false();
  });
});

describe('recognising a process', () => {
  it('should identify only a live process naming the socket, and refuse pid 0, 1 and non-integers', () => {
    // Arrange
    const read = table({ 4242: SERVER, 7: { ...SERVER, defunct: true } });

    // Act / Assert
    should(identify(4242, SOCKET, read)).deepEqual(recorded);
    should(identify(4242, '/tmp/other/s', read)).be.undefined();
    should(identify(7, SOCKET, read)).be.undefined();
    should(identify(1, SOCKET, table({ 1: SERVER }))).be.undefined();
    should(identify(0, SOCKET, table({ 0: SERVER }))).be.undefined();
    should(identify(1.5, SOCKET, table({ 1: SERVER }))).be.undefined();
  });

  it('should tell the same process from a reused pid by start time', () => {
    // Act / Assert
    should(stillRunning(recorded, table({ 4242: SERVER }))).be.true();
    should(stillRunning(recorded, table({ 4242: { ...SERVER, start: '2000' } }))).be.false();
    should(stillRunning(recorded, table({ 4242: { ...SERVER, defunct: true } }))).be.false();
    should(stillRunning(recorded, table({}))).be.false();
  });

  it('should read a tmux argv naming the socket as -S, or in the title tmux gives its server', () => {
    // Act / Assert
    should(namesSocket(['tmux', '-S', SOCKET], SOCKET)).be.true();
    should(namesSocket(['tmux:', 'server', `(${SOCKET})`], SOCKET)).be.true();
    should(namesSocket(['tmux', '-S', `${SOCKET}2`], SOCKET)).be.false();
    should(namesSocket(['tmux', SOCKET], SOCKET)).be.false();
  });

  it('should find the start time and state after a command name that holds spaces and parentheses', () => {
    // Arrange — fields 3.. of /proc/<pid>/stat; the start time is the 22nd.
    const fields = ['S', ...Array.from({ length: 18 }, (_, at) => String(at)), '123456'];

    // Act / Assert
    should(parseProcStat(`4242 (tmux: server (x y)) ${fields.join(' ')} 0 0`)).deepEqual({
      start: '123456',
      defunct: false,
    });
    should(parseProcStat(`4242 (sh) ${['Z', ...fields.slice(1)].join(' ')}`)?.defunct).be.true();
    should(parseProcStat('4242 (sh) S 1')).be.undefined();
  });

  it('should read this very process from the host, and never match it to a socket it does not name', () => {
    // Act
    const facts = hostProcessReader(process.pid);

    // Assert — the real /proc (or ps) reader answers for a live process, and a socket nobody used names none.
    should(facts?.defunct).be.false();
    should(identify(process.pid, '/nonexistent/fy-identity-unit.sock')).be.undefined();
    should(signalVerified({ pid: process.pid, start: 'not-its-start' }, '/nonexistent/s', 'SIGKILL')).be.false();
  });
});
