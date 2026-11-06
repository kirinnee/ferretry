import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileTranscriptTail } from '../../../../src/adapters/index.ts';
import { parseSessionId } from '../../../../src/lib/index.ts';

/** `FileTranscriptTail` (&B153) against a real file: the open, stat, positioned read and close are node:fs. */

const ID = parseSessionId('mw4m80sx-5624d777');
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function transcript(content: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'fy-transcript-tail-'));
  homes.push(home);
  const path = join(home, 'conversation.jsonl');
  await writeFile(path, content);
  return path;
}

describe('FileTranscriptTail', () => {
  it('reads the last bytes of the file the resolver names, and the whole of a smaller one', async () => {
    const path = await transcript('0123456789');
    const tail = new FileTranscriptTail(async () => path);

    should(await tail.tail(ID, 4)).equal('6789');
    should(await tail.tail(ID, 1024)).equal('0123456789');
  });

  it('reads nothing for a session with no bound transcript, and fails for one that is gone', async () => {
    should(await new FileTranscriptTail(async () => undefined).tail(ID, 16)).be.undefined();
    await should(
      new FileTranscriptTail(async () => '/nonexistent/fy-b153/transcript.jsonl').tail(ID, 16),
    ).be.rejected();
  });
});
