import { describe, it } from 'bun:test';
import { PASSKEY_WINDOW_PATH } from '@ferretry/protocol';
import should from 'should';
import type { z } from 'zod';
import { PAIRED_DEVICES_PATH, ProtocolPasskeyGateway } from '../../../src/lib/passkey/gateway';
import type { PasskeyApiClient } from '../../../src/lib/passkey/ports';
import { CLOSES_AT, PIXEL, PIXEL_ID } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing really runs. */
function fakeClient(payload: unknown, calls: Call[] = []): PasskeyApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('passkey routes', () => {
  it('should dial the routes the daemon serves', () => {
    should(PAIRED_DEVICES_PATH).equal('/v1/pair/devices');
    should(PASSKEY_WINDOW_PATH).equal('/v1/passkeys/registration-window');
  });
});

describe('protocol passkey gateway', () => {
  it('should list the paired devices and nothing else from the view', async () => {
    // Arrange
    const calls: Call[] = [];
    const subject = new ProtocolPasskeyGateway(fakeClient({ devices: [PIXEL], hostLocal: true }, calls));

    // Act
    const actual = await subject.devices();

    // Assert
    should(actual).eql([PIXEL]);
    should(calls[0]?.path).equal(PAIRED_DEVICES_PATH);
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
    should(calls[0]?.path).equal(PASSKEY_WINDOW_PATH);
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ deviceId: PIXEL_ID });
  });

  it('should fail on an answer that is not a window rather than print undefined', async () => {
    // Arrange
    const subject = new ProtocolPasskeyGateway(fakeClient({ error: 'nope' }));

    // Act + Assert
    await should(subject.openWindow(PIXEL_ID)).be.rejected();
  });
});
