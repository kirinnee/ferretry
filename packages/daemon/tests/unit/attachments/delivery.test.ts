import { describe, it } from 'bun:test';
import should from 'should';
import { deliveredFilename, messageWithAttachments } from '../../../src/lib/attachments/index.ts';

describe('attachment delivery', () => {
  it('names a delivered copy after the uploaded file, without characters a prompt would have to quote', () => {
    should(deliveredFilename('screenshot.png')).equal('screenshot.png');
    should(deliveredFilename('C:\\Users\\me\\My Notes (1).md')).equal('My-Notes-1-.md');
    should(deliveredFilename('../../.hidden')).equal('hidden');
  });

  it('never reuses a name the store reserves, and never yields an empty name', () => {
    should(deliveredFilename('original')).equal('attachment-original');
    should(deliveredFilename('manifest.json')).equal('attachment-manifest.json');
    should(deliveredFilename('...')).equal('attachment-file');
  });

  it('leaves a message with nothing attached exactly as it was', () => {
    should(messageWithAttachments('hello', [])).equal('hello');
  });

  it('lists every attached file by path and type after the message', () => {
    should(
      messageWithAttachments('see these', [
        { path: '/state/attachments/d/s/att_1/shot.png', mime: 'image/png' },
        { path: '/state/attachments/d/s/att_2/note.m4a', mime: 'audio/mp4' },
      ]),
    ).equal(
      'see these\n\nAttached files — open them from these paths:\n' +
        '- /state/attachments/d/s/att_1/shot.png (image/png)\n' +
        '- /state/attachments/d/s/att_2/note.m4a (audio/mp4)',
    );
  });
});
