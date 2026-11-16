import { describe, expect, test } from 'bun:test';
import { ProcListenerProver } from '../../../daemon/worker/control/adapters/listener-prover.ts';
import { NodeBrowserLoginRuntime } from '../../../daemon/worker/control/adapters/login-runtime.ts';
import type { SessionBrowserModeOptions } from '../../../daemon/worker/launcher.ts';
import { ProxySignInRelay, type SignInRelayListen } from '../../../daemon/proxy/adapters/sign-in-relay.ts';
import { REFUSING_FACTS } from '../../support/listener-prover.ts';

describe('the listener prover is handed in, never defaulted (M1)', () => {
  test('M1 a prover over facts that refuse every read answers unknown, never proven', async () => {
    // Arrange
    const prover = new ProcListenerProver(REFUSING_FACTS);

    // Act
    const proof = await prover.prove(9222, 4242);
    const holder = await prover.holder(9222);

    // Assert
    expect(proof).toEqual({ kind: 'unknown' });
    expect(holder).toBeUndefined();
  });

  test('M1 leaving the prover out of a launcher, a login runtime or a relay is a type error', () => {
    // Arrange / Act / Assert — the typecheck is the assertion: each line below fails `tsc` without its directive.
    // @ts-expect-error `listenerProver` is required
    const modes: SessionBrowserModeOptions = {};
    // @ts-expect-error `listenerProver` is required
    const login = () => new NodeBrowserLoginRuntime({ processes: {} as never, display: {} as never });
    // @ts-expect-error `holder` is required
    const listen: SignInRelayListen = { port: 0 };
    const relay = () =>
      ProxySignInRelay.start({ scheme: 'http', host: '127.0.0.1', port: 1 }, { username: '', password: '' }, 1, listen);
    expect([typeof modes, typeof login, typeof relay, typeof listen]).toEqual([
      'object',
      'function',
      'function',
      'object',
    ]);
  });
});
