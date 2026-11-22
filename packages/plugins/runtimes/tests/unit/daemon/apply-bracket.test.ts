import { describe, it } from 'bun:test';
import should from 'should';
import { ApiError } from '@ferretry/kernel/contract';
import {
  assertRequestLive,
  assertRequestLiveBetweenWrites,
  type ApplyBracket,
} from '../../../daemon/lib/service/apply-bracket.ts';

/** A bracket whose request has (or has not) ended. */
const bracketOf = (ended: boolean): ApplyBracket => {
  const controller = new AbortController();
  if (ended) controller.abort();
  return { signal: controller.signal };
};

describe('assertRequestLive', () => {
  it('lets an apply with no bracket, no signal or a live request go on', () => {
    should(() => assertRequestLive(undefined)).not.throw();
    should(() => assertRequestLive({})).not.throw();
    should(() => assertRequestLive(bracketOf(false))).not.throw();
  });

  it('answers 499 request_aborted when the request already ended, before anything was written', () => {
    let thrown: unknown;
    try {
      assertRequestLive(bracketOf(true));
    } catch (error) {
      thrown = error;
    }
    should(thrown).be.instanceOf(ApiError);
    const error = thrown as ApiError;
    should(error.status).equal(499);
    should(error.code).equal('request_aborted');
    should(error.message).equal('the request ended before this change was applied; nothing was written');
  });
});

describe('assertRequestLiveBetweenWrites', () => {
  it('lets an apply with no bracket, no signal or a live request write its next file', () => {
    should(() => assertRequestLiveBetweenWrites(undefined)).not.throw();
    should(() => assertRequestLiveBetweenWrites({})).not.throw();
    should(() => assertRequestLiveBetweenWrites(bracketOf(false))).not.throw();
  });

  it('answers 499 request_aborted when the request ended mid-way, saying what stays', () => {
    let thrown: unknown;
    try {
      assertRequestLiveBetweenWrites(bracketOf(true));
    } catch (error) {
      thrown = error;
    }
    should(thrown).be.instanceOf(ApiError);
    const error = thrown as ApiError;
    should(error.status).equal(499);
    should(error.code).equal('request_aborted');
    should(error.message).equal(
      'the request ended while this change was being applied; it stopped before its next write, and what was already written stays',
    );
  });
});
