import { describe, expect, it } from 'bun:test';
import { ADVERTISEMENT_REFUSALS, WILDCARD_BIND_HOST } from '../../../contract/index.ts';
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
  it('P84 should have one remedy per reason, no two the same', () => {
    const remedies = ADVERTISEMENT_REFUSALS.map(reason => refusalNotice(reason).remedy);
    expect(new Set(remedies).size).toBe(ADVERTISEMENT_REFUSALS.length);
    expect(localOnlyNotice('http://127.0.0.1:7431').remedy).toBe(
      refusalNotice('loopback-bind').remedy.replace('http://192.168.1.10', 'http://192.168.1.10:7431'),
    );
  });

  it('P85 should bind every interface and set publicUrl for a local-only daemon, naming the exposure and keeping loopback', () => {
    const { audience, remedy } = localOnlyNotice('http://127.0.0.1:7431');
    expect(audience).toContain('no QR is drawn');
    expect(remedy).toContain(`"host" to "${WILDCARD_BIND_HOST}"`);
    expect(remedy).toContain('accepts connections from other devices on your network');
    expect(remedy).toContain('"publicUrl"');
    expect(remedy).toContain('restart the daemon');
    expect(remedy).toContain('keep reaching it on loopback');
  });

  it('P86 should ask a wildcard bind for publicUrl alone, and a missing port for a start or a written port', () => {
    const wildcard = refusalNotice('wildcard-bind').remedy;
    expect(wildcard).toContain('"publicUrl"');
    expect(wildcard).not.toContain(WILDCARD_BIND_HOST);
    const noPort = refusalNotice('no-port').remedy;
    expect(noPort).toContain('start the daemon so it binds a port');
    expect(noPort).toContain('config/connections.yaml');
    expect(noPort).not.toContain('daemon.json');
    expect(noPort).not.toContain('bind entry');
    expect(noPort).toContain('write "port" under "direct"');
    expect(noPort).toContain('"publicUrl" cannot supply an address nothing has bound');
  });

  it("P87 should carry this daemon's own port in the example, never the compiled-in default", () => {
    expect(localOnlyNotice('http://127.0.0.1:51234').remedy).toContain('http://192.168.1.10:51234');
    expect(localOnlyNotice('http://127.0.0.1:51234').remedy).not.toContain(':7431');
  });
});
