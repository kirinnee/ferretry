import { describe, expect, it } from 'bun:test';
import { CommandError } from '../../../cli/lib/errors.ts';
import { mimeOfPath, shellFiles } from '../../../cli/lib/send/files.ts';

describe('shellFiles', () => {
  it('reads text through the shell, and names the path when it cannot (exit 2)', async () => {
    const files = shellFiles({
      readText: async path => {
        if (path === 'gone.md') throw new Error('ENOENT: no such file or directory');
        return 'words';
      },
    });
    expect(await files.readText('a.md')).toBe('words');
    const refused = await files.readText('gone.md').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CommandError);
    expect((refused as CommandError).message).toBe('cannot read gone.md: ENOENT: no such file or directory');
    expect((refused as CommandError).exitCode).toBe(2);
  });

  it('stages an attachment under its base name, its type and its base64, and refuses an empty one', async () => {
    const files = shellFiles({
      readBytes: async path => (path.endsWith('empty.png') ? new Uint8Array() : new Uint8Array([104, 105])),
    });
    expect(await files.readAttachment('/some/dir/Report.PDF')).toEqual({
      filename: 'Report.PDF',
      mime: 'application/pdf',
      base64: 'aGk=',
    });
    await expect(files.readAttachment('x/empty.png')).rejects.toThrow('attachment x/empty.png is empty');
  });

  it('a host with no reader says so instead of failing in the dark', async () => {
    const files = shellFiles({});
    await expect(files.readText('a.md')).rejects.toBeInstanceOf(CommandError);
    await expect(files.readAttachment('a.png')).rejects.toBeInstanceOf(CommandError);
  });

  it('types by extension, any case, and falls back to octet-stream', () => {
    expect(mimeOfPath('a.PNG')).toBe('image/png');
    expect(mimeOfPath('notes')).toBe('application/octet-stream');
    expect(mimeOfPath('archive.tar.gz')).toBe('application/octet-stream');
  });
});
