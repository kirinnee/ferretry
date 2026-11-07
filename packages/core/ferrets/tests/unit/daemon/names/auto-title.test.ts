import { describe, it } from 'bun:test';
import should from 'should';
import {
  isAutoTitled,
  MESSAGE_TITLE_LENGTH,
  nextAutoTitle,
  titleFromMessage,
  withAutoTitle,
} from '../../../src/lib/names/index.ts';

describe('auto-titling a session', () => {
  it('should title from the first line of a message, cut to a short title', () => {
    should(titleFromMessage('  Fix the sidebar\nand then the rest of it ')).equal('Fix the sidebar');
    const long = titleFromMessage('x'.repeat(200));
    should(long?.length).equal(MESSAGE_TITLE_LENGTH);
    should(long?.endsWith('…')).equal(true);
  });

  it('should refuse a message with no words or a slash command as a title', () => {
    should(titleFromMessage('   \n  ')).equal(undefined);
    should(titleFromMessage('/clear')).equal(undefined);
  });

  it('should treat the placeholder and a daemon-chosen name as retitlable, an owner name as final', () => {
    should(isAutoTitled({ name: 'interactive' })).equal(true);
    should(isAutoTitled({ name: 'Anything', nameSource: 'auto' })).equal(true);
    should(isAutoTitled({ name: 'Anything', nameSource: 'owner' })).equal(false);
    should(isAutoTitled({ name: 'Diene Work' })).equal(false);
    should(isAutoTitled({ name: 'interactive', nameSource: 'owner' })).equal(false);
  });

  it('should let a first message title only a placeholder, never a name already chosen', () => {
    should(nextAutoTitle({ name: 'interactive', nameSource: 'auto' }, 'message', 'Fix login')).equal('Fix login');
    should(nextAutoTitle({ name: 'Fix login', nameSource: 'auto' }, 'message', 'Another thing')).equal(undefined);
    should(nextAutoTitle({ name: 'interactive', nameSource: 'owner' }, 'message', 'Fix login')).equal(undefined);
  });

  it('should let a card title replace an auto name, and follow a changed card', () => {
    should(nextAutoTitle({ name: 'Fix login', nameSource: 'auto' }, 'card', 'Sidebar titles')).equal('Sidebar titles');
    should(nextAutoTitle({ name: 'interactive' }, 'card', 'Sidebar titles')).equal('Sidebar titles');
    should(nextAutoTitle({ name: 'Sidebar titles', nameSource: 'auto' }, 'card', 'Sidebar titles')).equal(undefined);
  });

  it('should never override a rename, whatever the source', () => {
    should(nextAutoTitle({ name: 'My name', nameSource: 'owner' }, 'card', 'Sidebar titles')).equal(undefined);
    should(nextAutoTitle({ name: 'Old name' }, 'card', 'Sidebar titles')).equal(undefined);
  });

  it('should stamp the document auto when it writes a title, and hand back the same one when it does not', () => {
    const document = { id: 's', name: 'interactive', nameSource: 'auto', cwd: '/w' };
    should(withAutoTitle(document, 'message', 'Hello there')).eql({ ...document, name: 'Hello there' });
    const legacy = { id: 's', name: 'interactive' };
    should(withAutoTitle(legacy, 'card', 'Card')).eql({ id: 's', name: 'Card', nameSource: 'auto' });
    const renamed = { id: 's', name: 'Mine', nameSource: 'owner' };
    should(withAutoTitle(renamed, 'card', 'Card')).equal(renamed);
  });
});
