import { describe, it } from 'bun:test';
import { SocketTicketSchema } from '@ferretry/protocol';
import should from 'should';
import { NodeSocketTicketSecrets } from '../../../src/adapters/api/index.ts';

/**
 * The real CSPRNG behind a socket ticket.
 *
 * A ticket is guessable or it is not, and that is decided here rather than in the domain — which is
 * why this is an integration case against the platform's own randomness instead of an injected fake.
 */
describe('NodeSocketTicketSecrets', () => {
  it('should mint a ticket of the width and shape the wire declares', () => {
    // Arrange
    const secrets = new NodeSocketTicketSecrets();

    // Act
    const ticket = secrets.ticket();

    // Assert — the schema is what the daemon answers with and the browser parses, so a ticket the
    // adapter mints must satisfy it or the route would refuse its own credential.
    should(SocketTicketSchema.parse(ticket)).equal(ticket);
  });

  it('should never mint the same ticket twice', () => {
    // Arrange
    const secrets = new NodeSocketTicketSecrets();

    // Act — 256 bits from the platform CSPRNG; a repeat here means the source is not random at all.
    const minted = new Set(Array.from({ length: 64 }, () => secrets.ticket()));

    // Assert
    should(minted.size).equal(64);
  });

  it('should carry the full 256 bits it was given', () => {
    // Arrange — a truncating encoder would still satisfy the schema by accident, so the byte width is
    // asserted against a known input rather than inferred from the output's length.
    const secrets = new NodeSocketTicketSecrets(size => Buffer.alloc(size, 0));

    // Act
    const ticket = secrets.ticket();

    // Assert — 32 zero bytes are 43 base64url characters, which is exactly what the schema demands.
    should(ticket).equal(`fy_ticket_${'A'.repeat(43)}`);
    should(SocketTicketSchema.parse(ticket)).equal(ticket);
  });
});
