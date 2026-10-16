/**
 * Export settings: this machine's configuration files as one zip, without secrets (spec R6, R5;
 * build plan P9), as data.
 *
 * WHY THERE ARE NO SECRETS IN IT. A configuration file may never hold a secret value — the daemon
 * refuses a file with one, and a secret is named as `${secret:NAME}` — so the files ARE the export.
 * The one exception is a file the daemon has refused: a pasted key is exactly what makes a file
 * invalid, and an invalid file is still on disk as it was typed. Every invalid file is therefore LEFT
 * OUT and listed, so the zip only ever carries text the daemon has accepted as secret-free.
 *
 * The zip is built here, in the browser, from files the machine already serves one at a time
 * (`GET /v1/config/status`, then `GET /v1/config/file`): no new route, no new holder. Stored entries
 * (no compression) — a few kilobytes of YAML do not need it, and a stored zip is a format every
 * operating system opens.
 *
 * Pure: texts in, bytes out.
 */

import { type ConfigStatusView, secretReference } from '@ferretry/protocol';

/** One file in the export, by its path relative to the configuration directory. */
export interface ExportFile {
  readonly path: string;
  readonly text: string;
}

/** Which files go in, and which stay out and why. */
export interface ExportPlan {
  readonly include: readonly string[];
  readonly leftOut: readonly { readonly path: string; readonly reason: string }[];
}

/** The folder every entry sits under inside the zip, so unzipping never scatters files. */
export const EXPORT_ROOT = 'config';

export const LEFT_OUT_INVALID =
  'it does not check, so it is left out: an invalid file can hold a pasted secret. Fix it (fy config check), then export again.';

/** Every file the machine reports, minus the invalid ones. */
export const exportPlan = (status: ConfigStatusView): ExportPlan => ({
  include: status.files.filter(file => file.state !== 'invalid').map(file => file.path),
  leftOut: status.files
    .filter(file => file.state === 'invalid')
    .map(file => ({ path: file.path, reason: LEFT_OUT_INVALID })),
});

/** `ferretry-settings-studio-mac-2026-10-16.zip`: the machine, and the day, in the name. */
export const exportFileName = (machineName: string, when: Date): string => {
  const machine = machineName.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'machine';
  return `ferretry-settings-${machine}-${when.toISOString().slice(0, 10)}.zip`;
};

/** The zip's listing as a person reads it: one path per line, and the promise. */
export const exportManifest = (fileName: string, files: readonly ExportFile[]): string =>
  [
    fileName,
    ...files.map(file => `  ${EXPORT_ROOT}/${file.path}`),
    `  # secrets: none (only ${secretReference('NAME')} references)`,
  ].join('\n');

// ── The zip ──────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** CRC-32 (IEEE), as the zip format checks each entry with. */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** The MS-DOS time and date words a zip entry carries, in UTC. */
const dosStamp = (when: Date): { readonly time: number; readonly date: number } => ({
  time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | Math.floor(when.getUTCSeconds() / 2),
  date: ((Math.max(when.getUTCFullYear(), 1980) - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
});

/** Bit 11: the names are UTF-8. */
const UTF8_FLAG = 0x0800;

/**
 * A zip of `files` under {@link EXPORT_ROOT}, stored without compression. Local headers, then the
 * central directory, then its end record: the minimum every unzip accepts.
 */
export const zipFiles = (files: readonly ExportFile[], when: Date): Uint8Array => {
  const encoder = new TextEncoder();
  const { time, date } = dosStamp(when);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(`${EXPORT_ROOT}/${file.path}`);
    const data = encoder.encode(file.text);
    const crc = crc32(data);
    const header = new Uint8Array(30 + name.length);
    const head = new DataView(header.buffer);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, UTF8_FLAG, true);
    head.setUint16(8, 0, true);
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    header.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const record = new DataView(entry.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, UTF8_FLAG, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    entry.set(name, 46);
    local.push(header, data);
    central.push(entry);
    offset += header.length + data.length;
  }
  const directorySize = central.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, files.length, true);
  tail.setUint16(10, files.length, true);
  tail.setUint32(12, directorySize, true);
  tail.setUint32(16, offset, true);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
