/**
 * THE REAL PDF WORKER, WITH THE REAL QPDF, ON A PDF THAT IS REALLY ENCRYPTED.
 *
 * Every other test of PDF unlock replaces the worker with a fake, so nothing proved the worker program
 * starts, finds the qpdf engine it embeds, and decrypts — which is how a compiled daemon shipped one that
 * could do none of it. These start the real worker from source; the release smoke starts the same worker
 * inside every compiled target through `fyd --check`.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import QPDF_WASM_PATH from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm' with { type: 'file' };
import { decryptPdfInMemory, probePdfDecryptWorker } from '../../../src/adapters/attachments/index.ts';
import { PdfDecryptError } from '../../../src/lib/attachments/index.ts';

interface Qpdf {
  callMain(args: string[]): number;
  FS: { readFile(path: string): Uint8Array };
}

/** An empty PDF encrypted with AES-256 under `password`, made by the same qpdf the worker runs. */
async function encryptedPdf(password: string): Promise<Uint8Array> {
  const { default: factory } = await import('@neslinesli93/qpdf-wasm');
  const qpdf = await (factory as unknown as (options: object) => Promise<Qpdf>)({
    locateFile: () => QPDF_WASM_PATH,
    noInitialRun: true,
    print: () => undefined,
    printErr: () => undefined,
  });
  should(qpdf.callMain(['--empty', '--encrypt', password, `${password}-owner`, '256', '--', '/locked.pdf'])).equal(0);
  return qpdf.FS.readFile('/locked.pdf').slice();
}

describe('the PDF decrypt worker', () => {
  it('should start and load qpdf when probed', async () => {
    should(await probePdfDecryptWorker()).deepEqual({ ready: true });
  });

  it('should unlock a really encrypted PDF with its password, and only with it', async () => {
    // Arrange
    const locked = await encryptedPdf('open sesame');

    // Act
    const unlocked = await decryptPdfInMemory(locked, 'open sesame');
    const refused = await decryptPdfInMemory(locked, 'not it').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(new TextDecoder().decode(unlocked.subarray(0, 5))).equal('%PDF-');
    should(Buffer.from(unlocked).toString('latin1')).not.containEql('/Encrypt');
    should(refused).be.instanceof(PdfDecryptError);
    should((refused as PdfDecryptError).failure).equal('wrong_password');
  });
});
