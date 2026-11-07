import type { IdentitySigner } from '@ferretry/kernel/contract';

/** A session layer's identity signer for a test that signs nothing: every use is a failure the test names. */
export const unusedSigner: IdentitySigner = {
  sign: async () => {
    throw new Error('this test signs no relay claim');
  },
  signTunnel: async () => {
    throw new Error('this test signs no tunnel request');
  },
  signCatalog: async () => {
    throw new Error('this test signs no catalog');
  },
  signLinkStoreRequest: async () => {
    throw new Error('this test signs no link-store request');
  },
  signSecretOffer: async () => {
    throw new Error('this test signs no secret offer');
  },
};

/** A session layer's multiplexed connection, for a test whose carrier opens one link per socket. */
export const noConnection = (): never => {
  throw new Error('this test opens no multiplexed connection');
};
