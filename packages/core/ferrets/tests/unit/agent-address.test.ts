import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgentAddressCandidate,
  agentAddressName,
  ambiguousAgentAddressMessage,
  isLiveAgentCandidate,
  provedAgentReference,
  resolveAgentAddress,
} from '../../contract/agent-address.ts';

const aniya: AgentAddressCandidate = { id: 'mvb0sw7d-27f71326', name: 'aniya', status: 'running' };
const torrey: AgentAddressCandidate = { id: 'mvb0aaaa-11111111', name: 'Torrey', status: 'waiting' };
const oldAniya: AgentAddressCandidate = { id: 'lzz00000-00000000', name: 'aniya', status: 'stopped' };

describe('resolveAgentAddress', () => {
  it('should answer an exact session id as itself', () => {
    should(resolveAgentAddress('mvb0sw7d-27f71326', [aniya, torrey])).deepEqual({
      kind: 'session',
      id: 'mvb0sw7d-27f71326',
    });
  });

  it('should prefer an exact id even when a name spells the same thing', () => {
    // A session whose id happens to equal another session's name is still that session.
    const named: AgentAddressCandidate = { id: 'other', name: 'aniya-id', status: 'running' };
    const id: AgentAddressCandidate = { id: 'aniya-id', status: 'stopped' };
    should(resolveAgentAddress('aniya-id', [named, id])).deepEqual({ kind: 'session', id: 'aniya-id' });
  });

  it('should resolve a name case-insensitively, with or without the composer colon', () => {
    for (const reference of ['torrey', 'TORREY', ' Torrey ', ':torrey'])
      should(resolveAgentAddress(reference, [aniya, torrey])).deepEqual({ kind: 'session', id: torrey.id });
  });

  it('should prefer the live holder of a name over a dormant one', () => {
    should(resolveAgentAddress('aniya', [oldAniya, aniya])).deepEqual({ kind: 'session', id: aniya.id });
  });

  it('should resolve to the only holder even when it is dormant', () => {
    // Sending to a stopped agent revives it, so a lone dormant holder is a fine address.
    should(resolveAgentAddress('aniya', [oldAniya, torrey])).deepEqual({ kind: 'session', id: oldAniya.id });
  });

  it('should refuse two live holders with both candidates', () => {
    const revived: AgentAddressCandidate = { ...oldAniya, status: 'running' };
    should(resolveAgentAddress('Aniya', [aniya, revived, torrey])).deepEqual({
      kind: 'ambiguous',
      name: 'aniya',
      candidates: [aniya, revived],
    });
  });

  it('should refuse two dormant holders rather than guess', () => {
    const another: AgentAddressCandidate = { id: 'lzz11111-11111111', name: 'aniya' };
    should(resolveAgentAddress('aniya', [oldAniya, another])).deepEqual({
      kind: 'ambiguous',
      name: 'aniya',
      candidates: [oldAniya, another],
    });
  });

  it('should answer unknown for a name nobody holds and for a blank reference', () => {
    should(resolveAgentAddress('zelda', [aniya, torrey])).deepEqual({ kind: 'unknown' });
    should(resolveAgentAddress('  ', [aniya])).deepEqual({ kind: 'unknown' });
    should(resolveAgentAddress(':', [aniya])).deepEqual({ kind: 'unknown' });
  });
});

describe('agent address helpers', () => {
  it('should normalise a reference to the name it spells', () => {
    should(agentAddressName(' :Aniya ')).equal('aniya');
  });

  it('should read a missing or dormant status as not live', () => {
    should(isLiveAgentCandidate({ id: 'a' })).be.false();
    should(isLiveAgentCandidate({ id: 'a', status: 'kill_failed' })).be.false();
    should(isLiveAgentCandidate({ id: 'a', status: 'stalled' })).be.true();
  });

  it('should name every candidate and its status in the refusal', () => {
    should(ambiguousAgentAddressMessage('aniya', [aniya, { id: 'x' }])).equal(
      'the name aniya is held by 2 sessions on this machine: mvb0sw7d-27f71326 (running), x (status unknown); ' +
        'address one by its session id',
    );
  });
});

describe('provedAgentReference', () => {
  const fleet: readonly AgentAddressCandidate[] = [aniya, torrey, oldAniya];

  it('should prove an exact id as that ferret with its lowercase callsign', () => {
    should(provedAgentReference({ sessionId: torrey.id }, fleet)).deepEqual({ id: torrey.id, name: 'torrey' });
  });

  it('should prove a name through the addressing rule, preferring the live holder', () => {
    should(provedAgentReference({ name: 'Aniya' }, fleet)).deepEqual({ id: aniya.id, name: 'aniya' });
  });

  it('should prove nothing for a name two live ferrets hold', () => {
    const revived: AgentAddressCandidate = { ...oldAniya, status: 'running' };
    should(provedAgentReference({ name: 'aniya' }, [aniya, revived])).be.null();
  });

  it('should prove nothing for an unknown id or name', () => {
    should(provedAgentReference({ sessionId: 'nope' }, fleet)).be.null();
    should(provedAgentReference({ name: 'nobody' }, fleet)).be.null();
    should(provedAgentReference({}, fleet)).be.null();
  });

  it('should prove nothing for a name the grammar refuses', () => {
    should(provedAgentReference({ name: '9lives' }, [{ id: 'a', name: '9lives', status: 'running' }])).be.null();
  });

  it('should leave out a ferret without a callsign, with an unsafe id, or with a dot id', () => {
    const odd: readonly AgentAddressCandidate[] = [
      { id: 'no-name', status: 'running' },
      { id: '../etc', name: 'evil', status: 'running' },
      { id: '.', name: 'dot', status: 'running' },
      { id: '..', name: 'dotdot', status: 'running' },
    ];
    should(provedAgentReference({ sessionId: 'no-name' }, odd)).be.null();
    should(provedAgentReference({ sessionId: '../etc' }, odd)).be.null();
    should(provedAgentReference({ name: 'evil' }, odd)).be.null();
    should(provedAgentReference({ sessionId: '.' }, odd)).be.null();
    should(provedAgentReference({ sessionId: '..' }, odd)).be.null();
  });
});
