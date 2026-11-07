import { describe, it } from 'bun:test';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import should from 'should';
import manifest from '../../../../manifest.ts';
import { PASSKEY_WINDOW_PATH } from '../../../../contract/index.ts';
import { PAIRED_DEVICES_PATH, PASSKEY_ROUTES, ProtocolPasskeyGateway } from '../../../../cli/lib/passkey/gateway.ts';
import type { PasskeyApiClient } from '../../../../cli/lib/passkey/ports.ts';
import type { DaemonCallInit } from '../../../../cli/shell.ts';
import { CLOSES_AT, PIXEL, PIXEL_ID } from './fixtures';

interface Call {
  route: string;
  init: DaemonCallInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing really runs. */
function fakeClient(payload: unknown, calls: Call[] = []): PasskeyApiClient {
  return {
    call: async <Answer>(route: string, init?: DaemonCallInit): Promise<Answer> => {
      calls.push({ route, init });
      return (await Promise.resolve(payload)) as Answer;
    },
  };
}

describe('passkey routes', () => {
  it('should dial the routes the daemon serves', () => {
    should(PAIRED_DEVICES_PATH).equal('/v1/pair/devices');
    should(PASSKEY_WINDOW_PATH).equal('/v1/passkeys/registration-window');
    should(PASSKEY_ROUTES.openWindow).equal(`POST ${PASSKEY_WINDOW_PATH}`);
    const declared = (manifest.actions.routes as readonly { readonly key: string }[]).map(route => route.key);
    for (const key of Object.values(PASSKEY_ROUTES)) should(declared).containEql(key);
  });
});

describe('protocol passkey gateway', () => {
  it('should list the paired devices and nothing else from the view', async () => {
    // Arrange
    const calls: Call[] = [];
    const subject = new ProtocolPasskeyGateway(
      fakeClient({ devices: [PIXEL], hostLocal: true, mayWiden: FULL_DEVICE_GRANTS }, calls),
    );

    // Act
    const actual = await subject.devices();

    // Assert
    should(actual).eql([PIXEL]);
    should(calls[0]?.route).equal(`GET ${PAIRED_DEVICES_PATH}`);
    should(calls[0]?.init).equal(undefined);
  });

  it('should post the device id to the window route and parse what comes back', async () => {
    // Arrange
    const calls: Call[] = [];
    const opened = { deviceId: PIXEL_ID, deviceName: 'Pixel 8', closesAt: CLOSES_AT };
    const subject = new ProtocolPasskeyGateway(fakeClient(opened, calls));

    // Act
    const actual = await subject.openWindow(PIXEL_ID);

    // Assert
    should(actual).eql(opened);
    should(calls[0]?.route).equal(`POST ${PASSKEY_WINDOW_PATH}`);
    should(calls[0]?.init?.body).eql({ deviceId: PIXEL_ID });
  });

  it('should fail on an answer that is not a window rather than print undefined', async () => {
    // Arrange
    const subject = new ProtocolPasskeyGateway(fakeClient({ error: 'nope' }));

    // Act + Assert
    await should(subject.openWindow(PIXEL_ID)).be.rejected();
  });
});
