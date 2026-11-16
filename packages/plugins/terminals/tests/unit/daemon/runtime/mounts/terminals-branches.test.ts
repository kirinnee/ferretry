import { describe, it } from 'bun:test';
import should from 'should';
import { TerminalViewSchema } from '../../../../../contract/index.ts';
import { FERRET, jsonBody, mountHalf } from './support.ts';

describe('the terminal mount, when ownership cannot be recorded', () => {
  it('should open a shell with its ownership left blank when a device id cannot be put on the wire', async () => {
    // A device id the protocol cannot represent is no reason to refuse the shell, but it is a reason
    // not to print an owner nobody could render: the terminal opens unrecorded.
    // Arrange
    const half = await mountHalf();

    // Act
    const created = await half.call('POST', `/v1/ferrets/${FERRET}/terminals`, undefined, 'odd-device');

    // Assert
    should(created.status).equal(201);
    should(TerminalViewSchema.parse(jsonBody(created)).openedBy).be.undefined();
  });
});
