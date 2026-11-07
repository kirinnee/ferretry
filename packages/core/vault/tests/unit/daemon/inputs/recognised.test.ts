import { describe, it } from 'bun:test';
import should from 'should';
import { recognisedConsumer } from '../../../src/lib/input-requests/recognised.ts';

describe('recognising a program that asks for a secret', () => {
  it('should recognise the programs that prompt for a password', () => {
    for (const comm of ['sudo', 'ssh', 'ssh-add', 'gpg2', 'pinentry-curses', 'git-credential-store', '/usr/bin/SUDO'])
      should(recognisedConsumer(comm)).be.true();
  });

  it('should not recognise a shell or an interpreter', () => {
    for (const comm of ['bash', 'zsh', 'sh', 'fish', 'python3', 'node', 'bun', 'ruby', 'perl', ''])
      should(recognisedConsumer(comm)).be.false();
  });
});
