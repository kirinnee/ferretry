import { fileURLToPath } from 'node:url';

import type { PdfDecryptWorkerRequest, PdfDecryptWorkerResponse } from '../src/lib/attachments/pdf-decrypt-protocol.ts';

interface QpdfRuntime {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
}

type QpdfFactory = (options: { locateFile(): string; noInitialRun: boolean }) => Promise<QpdfRuntime>;

const QPDF_WASM_PATH = fileURLToPath(new URL('./qpdf.wasm', import.meta.resolve('@neslinesli93/qpdf-wasm')));
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

declare const self: { onmessage: ((event: MessageEvent<PdfDecryptWorkerRequest>) => void) | null };

self.onmessage = async event => {
  let passwordBytes: Uint8Array | undefined;
  let qpdf: QpdfRuntime | undefined;
  try {
    const request = event.data;
    if (!(request.input instanceof ArrayBuffer) || typeof request.password !== 'string' || request.maxBytes <= 0) {
      post({ ok: false, failure: 'unreadable_document' });
      return;
    }
    const { default: factory } = await import('@neslinesli93/qpdf-wasm');
    qpdf = await (factory as unknown as QpdfFactory)({ locateFile: () => QPDF_WASM_PATH, noInitialRun: true });
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
