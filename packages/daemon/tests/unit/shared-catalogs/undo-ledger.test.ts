import { describe, it } from 'bun:test';
import { QUICK_ADD_UNDO_SECONDS } from '@ferretry/protocol';
import should from 'should';
import { UndoLedger, type UndoRecord } from '../../../src/lib/shared-catalogs/undo-ledger.ts';
import { crypto } from './support.ts';

const RECORD: UndoRecord = {
  catalogId: `cat_${'A'.repeat(22)}`,
  itemId: `itm_${'B'.repeat(22)}`,
  revisionAfterAdd: 2,
  createdItem: true,
  createdCatalog: true,
  relisted: false,
};

describe('the undo ledger', () => {
  it('should hold a record until it is spent, and then answer nothing, however often it is asked', () => {
    const ledger = new UndoLedger(crypto);
    const { token } = ledger.issue(RECORD, 'host', 0);

    should(ledger.peek(token, 'host', 1)).equal(RECORD);
    should(ledger.peek(token, 'host', 2)).equal(RECORD);
    ledger.spend(token);
    should(ledger.peek(token, 'host', 3)).be.undefined();
    should(ledger.peek(token, 'host', 4)).be.undefined();
  });

  it('should not let another caller see or spend a token, and should drop a lapsed one', () => {
    const ledger = new UndoLedger(crypto);
    const { token } = ledger.issue(RECORD, 'device:one', 0);

    should(ledger.peek(token, 'device:two', 1)).be.undefined();
    should(ledger.peek(token, 'device:one', 2)).equal(RECORD);
    should(ledger.peek(token, 'device:one', QUICK_ADD_UNDO_SECONDS * 1_000)).be.undefined();
    should(ledger.peek(token, 'device:one', 1)).be.undefined();
  });

  it('should sweep lapsed tokens when it issues another, and make each token different', () => {
    const ledger = new UndoLedger(crypto);
    const first = ledger.issue(RECORD, 'host', 0);
    const second = ledger.issue(RECORD, 'host', QUICK_ADD_UNDO_SECONDS * 1_000 + 1);

    should(first.token).not.equal(second.token);
    should(first.token).match(/^cqu_[A-Za-z0-9_-]{22}$/u);
    should(ledger.peek(first.token, 'host', 0)).be.undefined();
  });

  it('should remember the highest signed revision of a catalog', () => {
    const ledger = new UndoLedger(crypto);
    should(ledger.wasSigned(RECORD.catalogId, 1)).be.false();
    ledger.noteSigned(RECORD.catalogId, 3);
    ledger.noteSigned(RECORD.catalogId, 2);
    should(ledger.wasSigned(RECORD.catalogId, 3)).be.true();
    should(ledger.wasSigned(RECORD.catalogId, 4)).be.false();
  });
});
