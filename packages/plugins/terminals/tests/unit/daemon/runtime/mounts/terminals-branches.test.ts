import { describe, it } from 'bun:test';
import { TerminalViewSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { terminalRoutes } from '../../../../src/lib/runtime/mounts/terminals.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, FakeTerminals, GRANTED } from './support.ts';

describe('the terminal mount, when ownership cannot be recorded', () => {
  it('should open a shell with its ownership left blank when a device id cannot be put on the wire', async () => {
    // A device id the protocol cannot represent is no reason to refuse the shell, but it is a reason
    // not to print an owner nobody could render: the terminal opens unrecorded.
    // Arrange
    const dispatch = new ApiDispatcher(new ApiRouter(terminalRoutes(new FakeTerminals())), CREDENTIALS, GRANTED);

    // Act
    const created = await dispatch.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/terminals',
        headers: { 'content-type': 'application/json' },
        body: '',
        device: { deviceId: 'device with spaces', appSession: 'app-one' },
      }),
    );

    // Assert
    should(created.status).equal(201);
    should(TerminalViewSchema.parse(jsonBody(created)).openedBy).be.undefined();
  });
});
