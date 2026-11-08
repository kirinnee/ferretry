import { it } from 'bun:test';
import should from 'should';
import { NodeDataChannelEngine } from '../../../daemon/adapters/webrtc/node-datachannel-engine.ts';
import { WebRtcEngineUnavailable } from '../../../daemon/lib/webrtc/index.ts';
import { clock } from '../../support/io.ts';
import { scriptedModule } from '../../support/scripted-webrtc-engine.ts';

// The cleanup-timeout regression uses the production adapter with an injected module, never the native library.
it('R691 should refuse every later offer once a release did not finish, and never release again', async () => {
  // Arrange
  const { module } = scriptedModule({ onRemote: peer => peer.gathering?.('complete') });
  let cleaned = 0;
  const subject = new NodeDataChannelEngine({
    clock,
    load: async () => ({
      ...module,
      cleanup: () => {
        cleaned += 1;
        throw new Error('libdatachannel error# cleanup timeout (possible deadlock)\n  at native');
      },
    }),
  });
  (await subject.answer('offer', [])).peer.close();

  // Act
  subject.release();
  subject.release();

  // Assert
  const refused: unknown = await subject.answer('offer', []).catch((error: unknown) => error);
  should(refused).be.instanceOf(WebRtcEngineUnavailable);
  should((refused as Error).message).equal(
    'the WebRTC engine did not stop cleanly (libdatachannel error# cleanup timeout (possible deadlock)); ' +
      'restart the daemon to use peer-to-peer connections again',
  );
  should(cleaned).equal(1);
});
