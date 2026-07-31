import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { NodeTaskBoardCredentialIssuer } from '../../../src/adapters/task-boards/node-task-board-credential-issuer.ts';

describe('NodeTaskBoardCredentialIssuer', () => {
  it('should mint a capability whose hash is the SHA-256 of the value it hands over', () => {
    // Arrange
    const issuer = new NodeTaskBoardCredentialIssuer();

    // Act
    const secret = issuer.capability();

    // Assert
    should(secret.hash).equal(createHash('sha256').update(secret.value, 'utf8').digest('hex'));
    should(issuer.hash(secret.value)).equal(secret.hash);
  });

  it('should mint 256 bits of capability, url-safe so it survives a header and a shell', () => {
    // Arrange
    const issuer = new NodeTaskBoardCredentialIssuer();

    // Act
    const secret = issuer.capability();

    // Assert
    should(Buffer.from(secret.value, 'base64url').byteLength).equal(32);
    should(secret.value).match(/^[A-Za-z0-9_-]+$/u);
  });

  it('should never mint the same capability twice', () => {
    // Arrange
    const issuer = new NodeTaskBoardCredentialIssuer();

    // Act
    const minted = new Set(Array.from({ length: 32 }, () => issuer.capability().value));

    // Assert
    should(minted.size).equal(32);
  });

  it('should prefix an id with what it names so an audit entry cannot confuse the two', () => {
    // Arrange
    const issuer = new NodeTaskBoardCredentialIssuer(undefined, () => 'fixed');

    // Act & Assert
    should(issuer.id('board')).equal('board-fixed');
    should(issuer.id('grant')).equal('grant-fixed');
  });

  it('should draw its capability bytes from the injected source', () => {
    // Arrange
    const issuer = new NodeTaskBoardCredentialIssuer(size => Buffer.alloc(size, 7));

    // Act
    const secret = issuer.capability();

    // Assert
    should(secret.value).equal(Buffer.alloc(32, 7).toString('base64url'));
  });

  it('should mint a unique id per call by default', () => {
    // Arrange
    const issuer = new NodeTaskBoardCredentialIssuer();

    // Act
    const ids = new Set(Array.from({ length: 8 }, () => issuer.id('grant')));

    // Assert
    should(ids.size).equal(8);
  });
});
