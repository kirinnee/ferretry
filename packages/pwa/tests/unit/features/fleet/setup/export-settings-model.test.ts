import { describe, expect, it } from 'bun:test';
import { type ConfigStatusView, secretReference } from '@ferretry/protocol';
import {
  crc32,
  EXPORT_ROOT,
  type ExportFile,
  exportFileName,
  exportManifest,
  exportPlan,
  LEFT_OUT_INVALID,
  zipFiles,
} from '../../../../../src/features/fleet/setup/export-settings-model.ts';

const statusOf = (...files: readonly [path: string, state: 'ok' | 'invalid' | 'pending'][]): ConfigStatusView => ({
  directory: '/home/you/.ferretry/config',
  files: files.map(([path, state]) => ({
    path,
    kind: 'warden',
    schema: 'warden',
    state,
  })),
  issues: [],
  pending: [],
  checkedAt: '2026-10-16T00:00:00.000Z',
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('exportPlan', () => {
  it('includes ok and pending files and leaves invalid ones out with the reason', () => {
    const plan = exportPlan(
      statusOf(['machine.yaml', 'ok'], ['warden.yaml', 'invalid'], ['voice.yaml', 'pending'], ['learning.yaml', 'ok']),
    );
    expect(plan.include).toEqual(['machine.yaml', 'voice.yaml', 'learning.yaml']);
    expect(plan.leftOut).toEqual([{ path: 'warden.yaml', reason: LEFT_OUT_INVALID }]);
  });

  it('is empty when the machine reports no files', () => {
    expect(exportPlan(statusOf())).toEqual({ include: [], leftOut: [] });
  });

  it('explains that an invalid file can hold a pasted secret', () => {
    expect(LEFT_OUT_INVALID).toContain('can hold a pasted secret');
  });
});

describe('exportFileName', () => {
  const when = new Date('2026-10-16T23:59:59.000Z');

  it('puts the machine and the ISO day in the name', () => {
    expect(exportFileName('studio-mac', when)).toBe('ferretry-settings-studio-mac-2026-10-16.zip');
  });

  it('replaces anything outside letters, digits, dot, underscore and dash, trimming the ends', () => {
    expect(exportFileName("  Kirin's Mac / Studio!  ", when)).toBe(
      'ferretry-settings-Kirin-s-Mac-Studio-2026-10-16.zip',
    );
  });

  it('falls back to machine when nothing is left of the name', () => {
    expect(exportFileName('', when)).toBe('ferretry-settings-machine-2026-10-16.zip');
    expect(exportFileName('///', when)).toBe('ferretry-settings-machine-2026-10-16.zip');
  });
});

describe('exportManifest', () => {
  it('lists the file name, one path per line under config/, and the no-secrets promise', () => {
    const files: readonly ExportFile[] = [
      { path: 'machine.yaml', text: 'a: 1' },
      { path: 'profiles/default.yaml', text: 'b: 2' },
    ];
    expect(exportManifest('ferretry-settings-x-2026-10-16.zip', files)).toBe(
      [
        'ferretry-settings-x-2026-10-16.zip',
        '  config/machine.yaml',
        '  config/profiles/default.yaml',
        `  # secrets: none (only ${secretReference('NAME')} references)`,
      ].join('\n'),
    );
  });

  it('still carries the promise for an empty export', () => {
    expect(exportManifest('empty.zip', []).split('\n')).toEqual([
      'empty.zip',
      `  # secrets: none (only ${secretReference('NAME')} references)`,
    ]);
  });
});

describe('crc32', () => {
  it('matches the standard check value for the ASCII digits 1 to 9', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for no bytes', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('is an unsigned 32-bit value', () => {
    const value = crc32(new TextEncoder().encode('a'));
    expect(value).toBe(0xe8b7be43);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});

describe('zipFiles', () => {
  const when = new Date(Date.UTC(2026, 9, 16, 13, 45, 31));
  const dosTime = (13 << 11) | (45 << 5) | 15;
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 16;
  const encoder = new TextEncoder();

  const files: readonly ExportFile[] = [
    { path: 'machine.yaml', text: 'agents: on\n' },
    { path: 'profiles/naïve.yaml', text: 'layers: []\n# café\n' },
  ];

  it('writes a local header per file: signature, UTF-8 flag, stored, CRC and sizes, then the bytes', () => {
    const bytes = zipFiles(files, when);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    for (const file of files) {
      const name = encoder.encode(`${EXPORT_ROOT}/${file.path}`);
      const data = encoder.encode(file.text);
      expect(view.getUint32(at, true)).toBe(0x04034b50);
      expect(view.getUint16(at + 4, true)).toBe(20);
      expect(view.getUint16(at + 6, true)).toBe(0x0800);
      expect(view.getUint16(at + 8, true)).toBe(0);
      expect(view.getUint16(at + 10, true)).toBe(dosTime);
      expect(view.getUint16(at + 12, true)).toBe(dosDate);
      expect(view.getUint32(at + 14, true)).toBe(crc32(data));
      expect(view.getUint32(at + 18, true)).toBe(data.length);
      expect(view.getUint32(at + 22, true)).toBe(data.length);
      expect(view.getUint16(at + 26, true)).toBe(name.length);
      expect(view.getUint16(at + 28, true)).toBe(0);
      expect(text(bytes.subarray(at + 30, at + 30 + name.length))).toBe(`config/${file.path}`);
      expect(text(bytes.subarray(at + 30 + name.length, at + 30 + name.length + data.length))).toBe(file.text);
      at += 30 + name.length + data.length;
    }
  });

  it('names every entry under config/ so unzipping never scatters files', () => {
    const bytes = zipFiles(files, when);
    const body = text(bytes);
    expect(body).toContain('config/machine.yaml');
    expect(body).toContain('config/profiles/naïve.yaml');
    expect(body).not.toContain('\u0000machine.yaml');
  });

  it('writes a central directory entry per file pointing at the right local header', () => {
    const bytes = zipFiles(files, when);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const localSizes = files.map(
      file => 30 + encoder.encode(`${EXPORT_ROOT}/${file.path}`).length + encoder.encode(file.text).length,
    );
    const directoryStart = localSizes.reduce((total, size) => total + size, 0);
    let at = directoryStart;
    let expectedOffset = 0;
    files.forEach((file, index) => {
      const name = encoder.encode(`${EXPORT_ROOT}/${file.path}`);
      const data = encoder.encode(file.text);
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      expect(view.getUint16(at + 4, true)).toBe(20);
      expect(view.getUint16(at + 6, true)).toBe(20);
      expect(view.getUint16(at + 8, true)).toBe(0x0800);
      expect(view.getUint16(at + 10, true)).toBe(0);
      expect(view.getUint16(at + 12, true)).toBe(dosTime);
      expect(view.getUint16(at + 14, true)).toBe(dosDate);
      expect(view.getUint32(at + 16, true)).toBe(crc32(data));
      expect(view.getUint32(at + 20, true)).toBe(data.length);
      expect(view.getUint32(at + 24, true)).toBe(data.length);
      expect(view.getUint16(at + 28, true)).toBe(name.length);
      expect(view.getUint32(at + 42, true)).toBe(expectedOffset);
      expect(view.getUint32(expectedOffset, true)).toBe(0x04034b50);
      expect(text(bytes.subarray(at + 46, at + 46 + name.length))).toBe(`config/${file.path}`);
      at += 46 + name.length;
      expectedOffset += localSizes[index] as number;
    });
    expect(at + 22).toBe(bytes.length);
  });

  it('ends with an end record carrying the entry count, the directory size and where it starts', () => {
    const bytes = zipFiles(files, when);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.length - 22;
    const directorySize = files.reduce((total, file) => total + 46 + encoder.encode(`config/${file.path}`).length, 0);
    const directoryStart = files.reduce(
      (total, file) => total + 30 + encoder.encode(`config/${file.path}`).length + encoder.encode(file.text).length,
      0,
    );
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 8, true)).toBe(files.length);
    expect(view.getUint16(end + 10, true)).toBe(files.length);
    expect(view.getUint32(end + 12, true)).toBe(directorySize);
    expect(view.getUint32(end + 16, true)).toBe(directoryStart);
    expect(view.getUint32(directoryStart, true)).toBe(0x02014b50);
  });

  it('clamps a date before 1980 to 1980', () => {
    const bytes = zipFiles([{ path: 'a.yaml', text: 'a: 1' }], new Date(Date.UTC(1975, 4, 6, 0, 0, 0)));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(12, true)).toBe((0 << 9) | (5 << 5) | 6);
  });

  it('still yields a valid 22-byte end record for no files', () => {
    const bytes = zipFiles([], when);
    expect(bytes.length).toBe(22);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x06054b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint32(12, true)).toBe(0);
    expect(view.getUint32(16, true)).toBe(0);
  });
});
