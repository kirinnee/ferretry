import { describe, it } from 'bun:test';
import should from 'should';
import {
  ALLOW_ALL_AGENT_CONTROL,
  auditHost,
  clipOutput,
  controlRefusal,
  CredentialAgentIdentities,
  type CredentialedSession,
  isShellForeground,
  secretsMatch,
  terminalInput,
} from '../../../src/lib/index.ts';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('agent-tools policy', () => {
  it('should turn text and named keys into the bytes a terminal receives, text first', () => {
    should(decode(terminalInput('ls -la', ['enter']))).equal('ls -la\r');
    should(decode(terminalInput(undefined, ['ctrl-c', 'up', 'enter']))).equal('\u0003\u001b[A\r');
    should(decode(terminalInput('q'))).equal('q');
  });

  it('should read a shell in the foreground as "nothing is running", login shells included', () => {
    should(['sh', 'bash', 'zsh', '-zsh', 'fish', 'dash'].every(isShellForeground)).be.true();
    should(['node', 'sleep', 'vim', 'python3', ''].some(isShellForeground)).be.false();
  });

  it('should keep the newest output when clipping', () => {
    should(clipOutput('abcdef', 3)).equal('def');
    should(clipOutput('abc', 3)).equal('abc');
    should(clipOutput('x'.repeat(10))).equal('x'.repeat(10));
  });

  it('should record a URL’s host only', () => {
    should(auditHost('https://user:pass@app.test:8443/path?token=secret#frag')).equal('app.test:8443');
  });

  it('should name the setting in every refusal, files included', () => {
    should(controlRefusal('files')).equal(
      'This machine does not let agents control files: "What agents may control › Files" is off in this machine\'s settings. Ask the person to turn it on if you need it.',
    );
  });

  it('should allow every kind until the machine settings say otherwise', async () => {
    should(
      await Promise.all(['terminal', 'browser', 'files'].map(kind => ALLOW_ALL_AGENT_CONTROL.allows(kind as 'files'))),
    ).deepEqual([true, true, true]);
  });
});

describe('CredentialAgentIdentities', () => {
  const sessions: CredentialedSession[] = [
    { id: 's1', name: 'Hadi', active: true, sessionCapabilityHash: 'hash:alpha' },
    { id: 's2', name: null, active: true, sessionCapabilityHash: 'hash:beta' },
    { id: 's3', name: 'Marin', active: false, sessionCapabilityHash: 'hash:gamma' },
  ];
  const resolver = new CredentialAgentIdentities(
    { snapshot: async () => sessions },
    capability => `hash:${capability}`,
    secretsMatch,
  );

  it('should resolve a credential to the live session it was minted for, and to nothing else', async () => {
    should(await resolver.resolve('alpha')).deepEqual({ sessionId: 's1', name: 'Hadi' });
    should(await resolver.resolve('beta')).deepEqual({ sessionId: 's2' });
  });

  it('should refuse a stopped session’s credential and one that names no session', async () => {
    should(await resolver.resolve('gamma')).be.undefined();
    should(await resolver.resolve('s1')).be.undefined();
    should(await resolver.resolve('')).be.undefined();
  });
});
