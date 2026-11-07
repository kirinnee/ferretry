import { describe, it } from 'bun:test';
import should from 'should';
import { broadWord, outcomeCount, umbrellaRefusal, umbrellaSignals } from '../../../cli/lib/umbrella.ts';

describe('umbrella cards', () => {
  it('should refuse titles that name a pile of work', () => {
    for (const title of [
      'Agenda overhaul',
      'Misc fixes',
      'Umbrella: relay work',
      'Epic: PWA polish',
      'System-wide logging',
      'Onboarding odds and ends',
      'Relay roadmap',
      'Catch-all for the inbox',
    ]) {
      should(umbrellaSignals({ title })).not.be.empty();
    }
  });

  it('should refuse a summary that lists three outcomes or more', () => {
    // Act
    const signals = umbrellaSignals({
      title: 'Inbox work',
      summary: 'Add the snooze toggle; fix the swipe crash; rename the To test tab',
    });

    // Assert
    should(signals).eql(['the summary lists 3 outcomes']);
  });

  it('should refuse a weak broad word only with a summary that lists two outcomes', () => {
    should(
      umbrellaSignals({ title: 'Various sidebar bugs', summary: 'Fix the badge count and fix the scroll jump' }),
    ).eql(['the title says "Various" and the summary lists 2 outcomes']);
    should(
      umbrellaSignals({
        title: 'Show all sessions in the sidebar',
        summary: 'List every session instead of the first 20',
      }),
    ).eql([]);
  });

  it('should pass a card that names one outcome', () => {
    for (const shape of [
      { title: 'Fix relay reconnect', summary: 'The phone reconnects after a relay drop' },
      { title: 'Add the --broad flag', summary: 'Create refuses an umbrella card without it' },
      { title: 'Make search fast', summary: 'Make search easy and fast' },
      { title: 'Rotate the pairing code' },
    ]) {
      should(umbrellaSignals(shape)).eql([]);
    }
  });

  it('should never refuse a card under a parent: it is one part of a bigger card', () => {
    should(umbrellaSignals({ title: 'Agenda overhaul', parent: { id: 'F12' } })).eql([]);
    should(umbrellaSignals({ title: 'Agenda overhaul', parent: null })).not.be.empty();
  });

  it('should count outcomes by line, semicolon, numbering, comma and "and", ignoring one-word tails', () => {
    should(outcomeCount('- Add the toggle\n- Fix the crash')).equal(2);
    should(outcomeCount('1) add the toggle 2) fix the crash 3) rename the tab')).equal(3);
    should(outcomeCount('Make search easy and fast')).equal(1);
    should(outcomeCount('')).equal(0);
  });

  it('should tell strong broad words from weak ones', () => {
    should(broadWord('Agenda overhaul')).eql({ word: 'overhaul', strong: true });
    should(broadWord('Fix everything in onboarding')).eql({ word: 'everything', strong: false });
    should(broadWord('Fix relay reconnect')).equal(undefined);
  });

  it('should refuse with the reasons and every way out', () => {
    // Act
    const text = umbrellaRefusal(['the title says "overhaul"'], 'zz');

    // Assert
    should(text).startWith('This looks like an umbrella card (the title says "overhaul"), and nothing was created.');
    should(text).containEql('zz card new … --parent F12');
    should(text).containEql('zz card new … --related F12');
    should(text).containEql('zz card new … --broad "<why this must be one card>"');
  });
});
