import { describe, it } from 'bun:test';
import { PinSnapshotSchema } from '@ferretry/protocol';
import should from 'should';
import { renderPinList, renderPinMutation } from '../../../src/lib/pins/render';
import { MESSAGE_ID, NOTE_ID, SESSION, agentNote, humanMessage, humanNote, snapshot } from './fixtures';

describe('pin listing', () => {
  it('should hold fixtures the protocol actually accepts', () => {
    // Act
    const actual = PinSnapshotSchema.safeParse(
      snapshot([humanNote(NOTE_ID, 'a note'), humanMessage(MESSAGE_ID, 'hi')]),
    );

    // Assert — a fixture the wire would reject proves nothing about rendering.
    should(actual.success).be.true();
  });

  it('should name the session when the board is empty', () => {
    // Act
    const actual = renderPinList(snapshot([]));

    // Assert
    should(actual).equal(`No pins in ${SESSION}.`);
  });

  it('should head the listing with a singular count for one pin', () => {
    // Act
    const actual = renderPinList(snapshot([humanNote(NOTE_ID, 'only one')]));

    // Assert
    should(actual.split('\n')[0]).equal(`1 pin in ${SESSION}`);
  });

  it('should render a note pin as its id, kind and text', () => {
    // Act
    const actual = renderPinList(snapshot([humanNote(NOTE_ID, 'rebase   before\n pushing')]));

    // Assert — whitespace is flattened so one pin is always one row.
    should(actual.split('\n')[1]).equal('  11111111  note  rebase before pushing');
  });

  it('should render a message pin as its block kind and preview', () => {
    // Act
    const actual = renderPinList(snapshot([humanMessage(MESSAGE_ID, 'the build is green', 'assistant')]));

    // Assert
    should(actual.split('\n')[1]).equal('  22222222  message  assistant: the build is green');
  });

  it('should say so when a pinned message has no preview text', () => {
    // Act
    const actual = renderPinList(snapshot([humanMessage(MESSAGE_ID, '   ', 'tools')]));

    // Assert
    should(actual).containEql('tools: (empty message)');
  });

  it('should tag an agent pin so a reader can tell who put it there', () => {
    // Act
    const actual = renderPinList(snapshot([agentNote(NOTE_ID, 'from a teammate', 'sol')]));

    // Assert
    should(actual.split('\n')[1]).equal('  11111111  note  [agent sol]  from a teammate');
  });

  it('should tag an unnamed agent pin without an empty name', () => {
    // Act
    const actual = renderPinList(snapshot([agentNote(NOTE_ID, 'anonymous', null)]));

    // Assert
    should(actual.split('\n')[1]).equal('  11111111  note  [agent]  anonymous');
  });

  it('should align the provenance column across mixed rows', () => {
    // Arrange
    const pins = [agentNote(NOTE_ID, 'tagged', 'sol'), humanMessage(MESSAGE_ID, 'untagged')];

    // Act
    const lines = renderPinList(snapshot(pins)).split('\n');

    // Assert — the human row keeps the column, so bodies line up.
    should(lines[1]).equal('  11111111  note     [agent sol]  tagged');
    should(lines[2]).equal('  22222222  message               assistant: untagged');
  });

  it('should elide a body longer than the row budget', () => {
    // Arrange
    const long = 'x'.repeat(200);

    // Act
    const actual = renderPinList(snapshot([humanNote(NOTE_ID, long)]));

    // Assert
    should(actual).containEql(`${'x'.repeat(79)}…`);
    should(actual).not.containEql('x'.repeat(80));
  });

  it('should keep a body that exactly fills the row budget intact', () => {
    // Arrange
    const exact = 'y'.repeat(80);

    // Act
    const actual = renderPinList(snapshot([humanNote(NOTE_ID, exact)]));

    // Assert
    should(actual).containEql(exact);
    should(actual).not.containEql('…');
  });
});

describe('pin mutation confirmations', () => {
  it('should confirm an add without naming an id the caller never chose', () => {
    // Act
    const actual = renderPinMutation('pinned', undefined, snapshot([humanNote(NOTE_ID, 'a')]));

    // Assert
    should(actual).equal(`pinned — 1 pin in ${SESSION}`);
  });

  it('should confirm a removal with the short id and the resulting count', () => {
    // Act
    const actual = renderPinMutation('removed', NOTE_ID, snapshot([]));

    // Assert
    should(actual).equal(`removed 11111111 — 0 pins in ${SESSION}`);
  });
});
