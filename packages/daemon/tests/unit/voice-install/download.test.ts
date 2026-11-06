import { describe, it } from 'bun:test';
import { VOICE_ENGINE_CODES } from '@ferretry/protocol';
import should from 'should';
import { downloadArchive, VoiceInstallError } from '../../../src/lib/voice-install/index.ts';
import { archiveOf, FakeNetwork, MemoryFiles, sha256 } from './support.ts';

const URL = 'https://example.test/model.tar.bz2';
const BODY = new Uint8Array(100_000).map((_, index) => (index * 31 + 7) % 251);
const DESTINATION = '/state/voice/downloads/x.part';

function fixture(body: Uint8Array = BODY) {
  const files = new MemoryFiles();
  const network = new FakeNetwork();
  network.bodies.set(URL, body);
  const archive = archiveOf(body, URL, body.length);
  const progress: number[] = [];
  const phases: string[] = [];
  const run = async (signal: AbortSignal = new AbortController().signal) =>
    await downloadArchive(
      { files, fetch: network.fetch },
      archive,
      DESTINATION,
      done => progress.push(done),
      phase => phases.push(phase),
      signal,
    );
  return { files, network, archive, progress, phases, run };
}

async function failure(promise: Promise<unknown>): Promise<VoiceInstallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VoiceInstallError) return error;
    throw error;
  }
  throw new Error('expected the download to fail');
}

describe('downloadArchive', () => {
  it('should download the whole file, verify it, and report rising progress', async () => {
    // Arrange
    const { files, run, progress, phases, network } = fixture();

    // Act
    await run();

    // Assert
    should(sha256(files.files.get(DESTINATION) ?? new Uint8Array())).equal(sha256(BODY));
    should(network.served).deepEqual([{ status: 200, range: undefined }]);
    should(phases).deepEqual(['downloading', 'verifying']);
    should(progress.at(-1)).equal(BODY.length);
    should(progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? 0))).be.true();
  });

  it('should resume from the first missing byte with a Range request and finish with the right hash', async () => {
    // Arrange — 40,000 bytes of the right prefix are already on disk.
    const { files, run, network, progress } = fixture();
    files.files.set(DESTINATION, BODY.slice(0, 40_000));

    // Act
    await run();

    // Assert
    should(network.served).deepEqual([{ status: 206, range: 'bytes=40000-' }]);
    should(files.files.get(DESTINATION)?.length).equal(BODY.length);
    should(progress[0]).equal(40_000);
  });

  it('should start again from nothing when the server ignores Range, never appending a whole file to a part', async () => {
    // Arrange
    const { files, run, network } = fixture();
    files.files.set(DESTINATION, BODY.slice(0, 40_000));
    network.options = { ignoreRange: true };

    // Act
    await run();

    // Assert
    should(network.served).deepEqual([{ status: 200, range: 'bytes=40000-' }]);
    should(files.files.get(DESTINATION)?.length).equal(BODY.length);
  });

  it('should begin again once when the server says the range cannot be satisfied', async () => {
    // Arrange
    const { files, run, network } = fixture();
    files.files.set(DESTINATION, BODY.slice(0, 10_000));
    network.options = { rangeNotSatisfiable: true };

    // Act
    await run();

    // Assert
    should(network.served.map(served => served.status)).deepEqual([416, 200]);
    should(files.files.get(DESTINATION)?.length).equal(BODY.length);
  });

  it('should delete the file and say so when the hash is wrong', async () => {
    // Arrange — the server serves a different body of the pinned length.
    const { files, run, network } = fixture();
    const wrong = BODY.slice();
    wrong[500] = (wrong[500] ?? 0) ^ 0xff;
    network.bodies.set(URL, wrong);

    // Act
    const error = await failure(run());

    // Assert
    should(error.code).equal(VOICE_ENGINE_CODES.hashMismatch);
    should(error.message).match(/SHA-256/u);
    should(files.files.has(DESTINATION)).be.false();
  });

  it('should delete a part that already holds wrong bytes, rather than resume them', async () => {
    // Arrange — the right length, the wrong prefix: a Range resume would fail the hash at the end.
    const { files, run } = fixture();
    const part = BODY.slice(0, 30_000);
    part[10] = (part[10] ?? 0) ^ 0xff;
    files.files.set(DESTINATION, part);

    // Act
    const error = await failure(run());

    // Assert
    should(error.code).equal(VOICE_ENGINE_CODES.hashMismatch);
    should(files.files.has(DESTINATION)).be.false();
  });

  it('should refuse a server that sends more than the pinned size, and keep nothing', async () => {
    // Arrange
    const { files, run, network } = fixture();
    network.bodies.set(URL, new Uint8Array(BODY.length + 5_000));

    // Act
    const error = await failure(run());

    // Assert
    should(error.code).equal(VOICE_ENGINE_CODES.hashMismatch);
    should(files.files.has(DESTINATION)).be.false();
  });

  it('should keep the part when the connection is cut, and the next try resumes from there', async () => {
    // Arrange
    const { files, run, network } = fixture();
    network.options = { cutAfter: 25_000 };

    // Act
    const error = await failure(run());
    const kept = files.files.get(DESTINATION)?.length;
    await run();

    // Assert
    should(error.code).equal(VOICE_ENGINE_CODES.download);
    should(kept).be.greaterThan(0).and.lessThan(BODY.length);
    should(network.served[1]).deepEqual({ status: 206, range: `bytes=${String(kept)}-` });
    should(sha256(files.files.get(DESTINATION) ?? new Uint8Array())).equal(sha256(BODY));
  });

  it('should answer a cancel as cancelled and keep the part so a later install resumes', async () => {
    // Arrange
    const { files, archive, network, phases } = fixture();
    const controller = new AbortController();
    network.options = { chunk: 4_000, onChunk: sent => sent === 3 && controller.abort() };

    // Act
    const error = await failure(
      downloadArchive(
        { files, fetch: network.fetch },
        archive,
        DESTINATION,
        () => undefined,
        phase => phases.push(phase),
        controller.signal,
      ),
    );

    // Assert
    should(error.code).equal(VOICE_ENGINE_CODES.cancelled);
    should(files.files.get(DESTINATION)?.length).be.greaterThan(0).and.lessThan(BODY.length);
  });

  it('should report the server status when the archive cannot be found', async () => {
    // Arrange
    const { run, network } = fixture();
    network.bodies.clear();

    // Act
    const error = await failure(run());

    // Assert
    should(error.code).equal(VOICE_ENGINE_CODES.download);
    should(error.message).match(/404/u);
  });

  describe('a 206 answer is trusted only when it is the rest of the pinned file', () => {
    const LAST = BODY.length - 1;
    const rangeAnswer = (contentRange: string | undefined, rest: Uint8Array, headers: Record<string, string> = {}) =>
      new Response(rest, {
        status: 206,
        headers: { ...(contentRange === undefined ? {} : { 'content-range': contentRange }), ...headers },
      });
    const resume = async (answer: Response) => {
      const { files, archive, progress } = fixture();
      files.files.set(DESTINATION, BODY.slice(0, 100));
      const run = async () =>
        await downloadArchive(
          { files, fetch: async () => answer },
          archive,
          DESTINATION,
          done => progress.push(done),
          () => undefined,
          new AbortController().signal,
        );
      return { files, run };
    };

    it.each([
      ['an end before the start', 'bytes 100-0/1'],
      ['a missing header', undefined],
      ['an unparseable header', 'bytes */100000'],
      ['a start that is not the first missing byte', `bytes 50-${String(LAST)}/${String(BODY.length)}`],
      ['an end short of the file', `bytes 100-${String(LAST - 1)}/${String(BODY.length)}`],
      ['an end past the file', `bytes 100-${String(LAST + 1)}/${String(BODY.length)}`],
      ['a total that is not the pinned size', `bytes 100-${String(LAST)}/${String(BODY.length + 1)}`],
    ])('should refuse %s, keep the part, and append nothing', async (_label, contentRange) => {
      // Arrange
      const { files, run } = await resume(rangeAnswer(contentRange, BODY.slice(100)));

      // Act
      const error = await failure(run());

      // Assert
      should(error.code).equal(VOICE_ENGINE_CODES.download);
      should(error.message).match(/not the rest of the/u);
      should(files.files.get(DESTINATION)?.length).equal(100);
    });

    it('should refuse a body whose announced length is not what the range says', async () => {
      // Arrange
      const { files, run } = await resume(
        rangeAnswer(`bytes 100-${String(LAST)}/${String(BODY.length)}`, BODY.slice(100), { 'content-length': '5' }),
      );

      // Act
      const error = await failure(run());

      // Assert
      should(error.code).equal(VOICE_ENGINE_CODES.download);
      should(files.files.get(DESTINATION)?.length).equal(100);
    });

    it('should accept the rest of the file when the server does not know the total', async () => {
      // Arrange
      const { files, run } = await resume(rangeAnswer(`bytes 100-${String(LAST)}/*`, BODY.slice(100)));

      // Act
      await run();

      // Assert
      should(sha256(files.files.get(DESTINATION) ?? new Uint8Array())).equal(sha256(BODY));
    });
  });

  it('should verify a part that is already complete without fetching anything', async () => {
    // Arrange
    const { files, run, network } = fixture();
    files.files.set(DESTINATION, BODY.slice());

    // Act
    await run();

    // Assert
    should(network.served).deepEqual([]);
  });
});
