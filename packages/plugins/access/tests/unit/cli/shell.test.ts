import { describe, expect, it } from 'bun:test';
import { ADVERTISEMENT_REFUSALS } from '../../../contract/index.ts';
import {
  localOnlyNotice as appLocalOnlyNotice,
  refusalNotice as appRefusalNotice,
} from '../../../app/shell-pairing.ts';
import {
  callDaemon,
  FyHttpError,
  FyTransportError,
  localOnlyNotice,
  readInvocation,
  refusalNotice,
} from '../../../cli/shell.ts';

/** The shell's refusal as `PluginClient.call` throws it: a `ShellError` subclass named `DaemonRefusal`. */
class DaemonRefusal extends Error {
  override readonly name = 'DaemonRefusal';
  readonly exitCode = 1;

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const throwing = (error: unknown) => ({
  call: async <Answer>(): Promise<Answer> => {
    throw error;
  },
});

describe('callDaemon', () => {
  it('P121 should turn a daemon refusal into the typed error the controllers read by status and code', async () => {
    const failure = await callDaemon(
      throwing(new DaemonRefusal('gone', 404, 'pairing_device_not_found')),
      'GET /x',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FyHttpError);
    expect(failure).toMatchObject({ status: 404, code: 'pairing_device_not_found', message: 'gone' });
  });

  it('P121 should turn a daemon that did not answer into a transport failure', async () => {
    const refused = Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' });
    const failure = await callDaemon(throwing(refused), 'DELETE /v1/pair/devices/:deviceId').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(FyTransportError);
    expect((failure as FyTransportError).cause).toBe(refused);
  });

  it('should leave a refusal the shell made before any contact for the router to print', async () => {
    const paused = Object.assign(new Error('Access is paused'), { name: 'PluginPausedError', exitCode: 69 });
    await expect(callDaemon(throwing(paused), 'GET /x')).rejects.toBe(paused);
  });

  it('should answer what the daemon answered', async () => {
    const client = { call: async <Answer>(): Promise<Answer> => ({ ok: true }) as Answer };
    expect(await callDaemon(client, 'GET /x')).toEqual({ ok: true });
  });
});

describe('readInvocation', () => {
  const shape = { command: 'revoke', args: ['device'], switches: ['yes', 'no-wait'], aliases: { y: 'yes' } };

  it('should read the switches commander accepted, including a short alias and a negation', () => {
    expect(readInvocation({ args: ['a'], options: { y: true, wait: false } }, shape)).toEqual({
      kind: 'read',
      args: ['a'],
      switches: { yes: true, wait: false },
    });
  });

  it('should refuse a negation commander never declared', () => {
    expect(readInvocation({ args: ['a'], options: { yes: false } }, shape)).toEqual({
      kind: 'refused',
      message: "error: unknown option '--no-yes'",
    });
  });
});

describe('the remedy sentences', () => {
  /** Every sentence an operator can be handed, for every reason and both local-only shapes. */
  const everyRemedy = (): readonly string[] => [
    ...ADVERTISEMENT_REFUSALS.map(reason => refusalNotice(reason).remedy),
    localOnlyNotice('http://127.0.0.1:7431').remedy,
    localOnlyNotice('http://127.0.0.1:7431', 'wss://relay.example').remedy,
  ];

  it('P84 should have one remedy per reason, no two the same', () => {
    const remedies = ADVERTISEMENT_REFUSALS.map(reason => refusalNotice(reason).remedy);
    expect(new Set(remedies).size).toBe(ADVERTISEMENT_REFUSALS.length);
    expect(localOnlyNotice('http://127.0.0.1:7431').remedy).toBe(refusalNotice('loopback-bind').remedy);
  });

  it('P85 should name the loopback listener with a discovered relay as the way to pair a phone, and invent no public address', () => {
    const { audience, remedy } = localOnlyNotice('http://127.0.0.1:7431');
    expect(audience).toContain('no QR is drawn');
    expect(remedy).toContain('keep the daemon on a loopback listener and let it use a discovered relay');
    expect(remedy).toContain('5.0 has no separate public-address setting yet');
    expect(remedy).toContain('does not give another device a direct route');
    // With a relay already discovered there is nothing to change.
    expect(localOnlyNotice('http://127.0.0.1:7431', 'wss://relay.example').remedy).toContain('nothing to change');
  });

  it('P86 should ask a wildcard bind for a loopback listener and a missing port for a start or a written port', () => {
    const wildcard = refusalNotice('wildcard-bind').remedy;
    expect(wildcard).toContain('"fyd --host 127.0.0.1"');
    expect(wildcard).toContain('a wildcard listener stays refused');
    expect(wildcard).toContain('5.0 has no separate public-address setting yet');
    const noPort = refusalNotice('no-port').remedy;
    expect(noPort).toContain('start the daemon so it binds a port ("--port" or FY_PORT chooses it)');
    expect(noPort).toContain('config/connections.yaml');
    expect(noPort).toContain('write "port" under "direct"');
    expect(noPort).toContain('a new "direct" block also needs "host"');
    expect(noPort).toContain('"direct" answers only while nothing is bound');
  });

  it('P87 should never send an operator to a v4 spelling or a setting 5.0 does not have', () => {
    for (const remedy of everyRemedy()) {
      for (const stale of ['publicUrl', 'daemon.json', 'carriers', 'bind entry', 'bind every interface', '0.0.0.0'])
        expect(remedy).not.toContain(stale);
    }
  });

  it('P88 should say the same sentences in the browser as at the terminal', () => {
    for (const reason of ADVERTISEMENT_REFUSALS) expect(appRefusalNotice(reason)).toEqual(refusalNotice(reason));
    for (const relay of [undefined, 'wss://relay.example'])
      expect(appLocalOnlyNotice('http://127.0.0.1:7431', relay)).toEqual(
        localOnlyNotice('http://127.0.0.1:7431', relay),
      );
  });
});
