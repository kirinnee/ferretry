import { describe, it } from 'bun:test';
import should from 'should';
import { TRANSCRIPT_EXPOSURE_BYTES, TranscriptFileExposure } from '../../../src/adapters/secure-copy/index.ts';
import { transcriptExposure } from '../../../src/lib/index.ts';

describe('transcriptExposure', () => {
  it('should find a value as it is, and as JSON lines escape it', () => {
    should(transcriptExposure('{"text":"token ghp_abc"}', 'ghp_abc')).equal('found');
    should(transcriptExposure('{"text":"a \\"quoted\\" one\\nline two"}', 'a "quoted" one\nline two')).equal('found');
    should(transcriptExposure('{"text":"nothing here"}', 'ghp_abc')).equal('clean');
    should(transcriptExposure('anything', '')).equal('clean');
  });
});

describe('TranscriptFileExposure', () => {
  it("should read the end of the session's transcript file and answer found or clean", async () => {
    const reads: [string, number][] = [];
    const exposure = new TranscriptFileExposure({ file: async () => '/t/s1.jsonl' }, async (file, bytes) => {
      reads.push([file, bytes]);
      return '{"tool_result":"ghp_seen"}';
    });

    should(await exposure.transcriptHolds('s1', 'ghp_seen')).equal('found');
    should(await exposure.transcriptHolds('s1', 'ghp_new')).equal('clean');
    should(reads[0]).eql(['/t/s1.jsonl', TRANSCRIPT_EXPOSURE_BYTES]);
  });

  it('should answer unknown when there is no transcript or it cannot be read', async () => {
    const none = new TranscriptFileExposure({ file: async () => undefined }, async () => '');
    const broken = new TranscriptFileExposure(
      {
        file: async () => {
          throw new Error('no record');
        },
      },
      async () => '',
    );
    const unreadable = new TranscriptFileExposure({ file: async () => '/t' }, async () => {
      throw new Error('EACCES');
    });

    should(await none.transcriptHolds('s1', 'v')).equal('unknown');
    should(await broken.transcriptHolds('s1', 'v')).equal('unknown');
    should(await unreadable.transcriptHolds('s1', 'v')).equal('unknown');
  });
});
