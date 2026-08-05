/**
 * Bounded rich previews for files the daemon has already admitted through its
 * descriptor containment and secrets policy.
 *
 * The preview NEVER receives an authenticated daemon URL. It fetches bounded
 * bytes through `browserFetch`, turns them into an object URL, and revokes that
 * URL on replacement/unmount. HTML is rendered in an iframe sandbox with no
 * scripts, same-origin, forms, popups, or top-navigation privileges. SVG stays
 * in an image element (rather than an iframe), so script-capable SVG never
 * joins the app DOM or gets a document execution context.
 */

import { Download, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import { fsApi } from './files-api.ts';
import { useFsResource } from './files-resource.ts';

const CSV_PREVIEW_BYTES = 512 * 1024;
const CSV_PREVIEW_ROWS = 400;
const CSV_PREVIEW_COLUMNS = 40;
const CSV_CELL_CHARS = 2_000;

export type RichFileKind = 'html' | 'pdf' | 'raster' | 'svg' | 'csv';

const extension = (path: string): string => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

export const richFileKind = (path: string): RichFileKind | null => {
  switch (extension(path)) {
    case 'html':
    case 'htm':
      return 'html';
    case 'pdf':
      return 'pdf';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'avif':
      return 'raster';
    case 'svg':
      return 'svg';
    case 'csv':
      return 'csv';
    default:
      return null;
  }
};

export const richFileMime = (path: string, kind: RichFileKind): string => {
  const ext = extension(path);
  if (kind === 'html') return 'text/html;charset=utf-8';
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'svg') return 'image/svg+xml';
  if (kind === 'csv') return 'text/csv;charset=utf-8';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
    }[ext] ?? 'application/octet-stream'
  );
};

export const bytesFromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  // `BlobPart` deliberately excludes SharedArrayBuffer-backed views. Allocate
  // this decoded document in an ordinary ArrayBuffer instead of casting away
  // the distinction; a renderer must never smuggle a shared buffer to Blob.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export interface CsvTable {
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
  /** An unclosed quoted field has no honest table interpretation. */
  readonly malformed: boolean;
}

/** A deliberately bounded RFC-4180-style reader. It supports quoted commas and
 * newlines, but stops after a readable table rather than allocating a million
 * cells for a generated CSV. */
export const parsePreviewCsv = (text: string): CsvTable => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  const pushCell = () => {
    if (row.length < CSV_PREVIEW_COLUMNS) row.push(cell);
    else truncated = true;
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    if (rows.length < CSV_PREVIEW_ROWS) rows.push(row);
    else truncated = true;
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        if (cell.length < CSV_CELL_CHARS) cell += '"';
        else truncated = true;
        index += 1;
      } else if (char === '"') quoted = false;
      else if (cell.length < CSV_CELL_CHARS) cell += char;
      else truncated = true;
      continue;
    }
    if (char === '"' && cell === '') quoted = true;
    else if (char === ',') pushCell();
    else if (char === '\n') pushRow();
    else if (char !== '\r') {
      if (cell.length < CSV_CELL_CHARS) cell += char;
      else truncated = true;
    }
    if (rows.length >= CSV_PREVIEW_ROWS) {
      truncated = true;
      break;
    }
  }
  if (rows.length < CSV_PREVIEW_ROWS && (cell !== '' || row.length > 0 || text.endsWith(','))) pushRow();
  return { rows, truncated, malformed: quoted };
};

/**
 * No `aria-label` on the wrapper: a plain `div` has no role that supports one, and the links inside
 * already carry their own accessible names. Labelling the wrapper would add a name most readers
 * never announce.
 */
const PreviewActions = ({ href, filename, canOpen }: { href: string; filename: string; canOpen: boolean }) => (
  <div className="kt-rich-file-actions">
    {canOpen && (
      <a className="kt-btn kt-btn--sm" href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={14} aria-hidden="true" />
        Open
      </a>
    )}
    <a className="kt-btn kt-btn--sm" href={href} download={filename}>
      <Download size={14} aria-hidden="true" />
      Download
    </a>
  </div>
);

export interface RichFilePreviewProps {
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly path: string;
  /** The parent increments this for an explicit file reload. */
  readonly revision: number;
}

export const RichFilePreview = ({ daemon, scope, path, revision }: RichFilePreviewProps) => {
  const kind = richFileKind(path);
  const key = kind === null ? null : `preview:${daemonSessionKey(scope)}:${path}:${revision}`;
  const preview = useFsResource(key, signal => fsApi.preview(daemon, scope, path, signal));
  const [url, setUrl] = useState<string | null>(null);
  const bytes = useMemo(() => {
    if (!preview.data?.base64) return null;
    try {
      return bytesFromBase64(preview.data.base64);
    } catch {
      return null;
    }
  }, [preview.data]);

  useEffect(() => {
    if (kind === null || bytes === null) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([bytes], { type: richFileMime(path, kind) }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, kind, path]);

  if (kind === null) return null;
  if (preview.loading)
    return (
      <div className="kt-fs-note" role="status">
        Loading safe preview…
      </div>
    );
  if (preview.error)
    return (
      <div className="kt-fs-note" data-tone="err" role="alert">
        Could not load a safe preview: {preview.error}
        <button type="button" className="kt-btn kt-btn--sm" onClick={preview.reload}>
          Retry
        </button>
      </div>
    );
  if (!preview.data?.base64 || bytes === null)
    return (
      <div className="kt-fs-note" data-tone="warn" role="status">
        Preview bytes are unavailable. The file may have changed or exceeded the daemon’s 1 MB view limit; use Raw or
        retry.
      </div>
    );
  if (kind === 'csv') {
    if (bytes.byteLength > CSV_PREVIEW_BYTES)
      return (
        <div className="kt-fs-note" data-tone="warn" role="status">
          CSV table previews stop at 512 KB to keep the app responsive. Download the file or use Raw instead.
        </div>
      );
    const table = parsePreviewCsv(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    if (table.malformed)
      return (
        <div className="kt-fs-note" data-tone="warn" role="status">
          This CSV has an unclosed quoted cell, so a table preview would be misleading. Use Raw or download it instead.
        </div>
      );
    return (
      <div className="kt-rich-file">
        <div className="kt-rich-file-table scroll-thin">
          <table>
            <tbody>
              {/* Position IS the identity here. A CSV row has no stable key, and this table is
                  rendered once from a parsed snapshot — it is never reordered, filtered or appended
                  to, so the reconciliation bug the rule guards against cannot occur. */}
              {/* biome-ignore-start lint/suspicious/noArrayIndexKey: a parsed CSV grid is positional and never reordered */}
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, columnIndex) =>
                    rowIndex === 0 ? <th key={columnIndex}>{cell}</th> : <td key={columnIndex}>{cell}</td>,
                  )}
                </tr>
              ))}
              {/* biome-ignore-end lint/suspicious/noArrayIndexKey: a parsed CSV grid is positional and never reordered */}
            </tbody>
          </table>
        </div>
        {table.truncated && (
          <div className="kt-fs-note" role="status">
            Table preview is capped at 400 rows, 40 columns, and 2,000 characters per cell.
          </div>
        )}
        {url && <PreviewActions href={url} filename={path.split('/').at(-1) ?? 'file.csv'} canOpen={false} />}
      </div>
    );
  }
  if (url === null)
    return (
      <div className="kt-fs-note" role="status">
        Preparing safe preview…
      </div>
    );
  const filename = path.split('/').at(-1) ?? 'file';
  return (
    <div className="kt-rich-file">
      {kind === 'html' && (
        <iframe
          className="kt-rich-file-frame"
          sandbox=""
          referrerPolicy="no-referrer"
          src={url}
          title={`Sandboxed preview of ${filename}`}
        />
      )}
      {kind === 'pdf' && (
        <iframe
          className="kt-rich-file-frame"
          sandbox=""
          referrerPolicy="no-referrer"
          src={url}
          title={`PDF preview of ${filename}`}
        />
      )}
      {(kind === 'raster' || kind === 'svg') && (
        <img className="kt-rich-file-image" src={url} alt={`Preview of ${filename}`} />
      )}
      <PreviewActions href={url} filename={filename} canOpen={kind === 'pdf' || kind === 'raster'} />
    </div>
  );
};
