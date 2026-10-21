// Imported as a FILE, so a compiled binary embeds it and this is a path inside the binary. Resolving it
// from the package at run time found it only in a source checkout, and the compiled worker could never
// load qpdf at all.
import QPDF_WASM_PATH from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm' with { type: 'file' };
import type {
  PdfDecryptProbeRequest,
  PdfDecryptWorkerRequest,
  PdfDecryptWorkerResponse,
} from '../src/lib/attachments/pdf-decrypt-protocol.ts';

interface QpdfRuntime {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
}

type QpdfFactory = (options: { locateFile(): string; noInitialRun: boolean }) => Promise<QpdfRuntime>;

const INPUT = '/input.pdf';
const OUTPUT = '/output.pdf';
const PASSWORD = '/password';
const diagnostics: string[] = [];

// qpdf-wasm binds its diagnostics during import. Keep untrusted document text out
// of the daemon's stderr, where it could otherwise become durable process output.
const record = (...parts: unknown[]): void => {
  if (diagnostics.length < 8) diagnostics.push(parts.map(String).join(' ').slice(0, 1_000));
};
const diagnosticsConsole = globalThis.console;
diagnosticsConsole.log = record;
diagnosticsConsole.error = record;
diagnosticsConsole.warn = record;

const post = (response: PdfDecryptWorkerResponse, transfer: ArrayBuffer[] = []): void => {
  (postMessage as (value: unknown, transfer?: ArrayBuffer[]) => void)(response, transfer);
};

declare const self: {
  onmessage: ((event: MessageEvent<PdfDecryptWorkerRequest | PdfDecryptProbeRequest>) => void) | null;
};

const startQpdf = async (): Promise<QpdfRuntime> => {
  const { default: factory } = await import('@neslinesli93/qpdf-wasm');
  return await (factory as unknown as QpdfFactory)({ locateFile: () => QPDF_WASM_PATH, noInitialRun: true });
};

self.onmessage = async event => {
  let passwordBytes: Uint8Array | undefined;
  let qpdf: QpdfRuntime | undefined;
  try {
    if ('probe' in event.data) {
      // Proves this thread started and qpdf loaded inside it — `fyd --check` asks, so a binary whose
      // worker or engine cannot start says so before anyone tries to unlock a PDF with it.
      qpdf = await startQpdf();
      post(
        qpdf.callMain(['--version']) === 0 ? { ok: true, probe: true } : { ok: false, failure: 'unreadable_document' },
      );
      return;
    }
    const request = event.data;
    if (!(request.input instanceof ArrayBuffer) || typeof request.password !== 'string' || request.maxBytes <= 0) {
      post({ ok: false, failure: 'unreadable_document' });
      return;
    }
    qpdf = await startQpdf();
    qpdf.FS.writeFile(INPUT, new Uint8Array(request.input));
    passwordBytes = new TextEncoder().encode(request.password);
    qpdf.FS.writeFile(PASSWORD, passwordBytes);
    const status = qpdf.callMain([`--password-file=${PASSWORD}`, '--decrypt', INPUT, OUTPUT]);
    if (status !== 0 && status !== 3) {
      post({ ok: false, failure: /password/i.test(diagnostics.join('\n')) ? 'wrong_password' : 'unreadable_document' });
      return;
    }
    const output = qpdf.FS.readFile(OUTPUT);
    if (output.byteLength === 0) return post({ ok: false, failure: 'unreadable_document' });
    if (output.byteLength > request.maxBytes) return post({ ok: false, failure: 'too_large' });
    const copy = output.slice();
    post({ ok: true, output: copy.buffer as ArrayBuffer }, [copy.buffer as ArrayBuffer]);
  } catch {
    post({ ok: false, failure: 'unreadable_document' });
  } finally {
    passwordBytes?.fill(0);
    try {
      qpdf?.FS.unlink(PASSWORD);
    } catch {}
    try {
      qpdf?.FS.unlink(OUTPUT);
    } catch {}
  }
};
