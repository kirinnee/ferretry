import { describe, expect, it } from 'bun:test';
import {
  classifyCodexRefreshFailure,
  mergeCodexRefreshEvidence,
  NO_CODEX_REFRESH_EVIDENCE,
  scanCodexRefreshEvidence,
} from '../../../daemon/lib/credentials/token-refresh.ts';

describe('scanCodexRefreshEvidence — only closed-set facts are taken from a harness’s output', () => {
  it('should find each failure word, whatever its case, and nothing else of the text', () => {
    const scanned = scanCodexRefreshEvidence(
      'ERROR: Refresh_Token_Reused while talking to the provider; invalid_grant',
    );
    expect(scanned).toEqual({ codes: ['refresh_token_reused', 'invalid_grant'], unauthorized: false });
    expect(JSON.stringify(scanned)).not.toContain('provider');
  });

  it('should find an HTTP 401 only on a line about the refresh, and not inside another number', () => {
    expect(scanCodexRefreshEvidence('refresh failed: status 401 Unauthorized').unauthorized).toBe(true);
    expect(scanCodexRefreshEvidence('status 401\nsomething else').unauthorized).toBe(false);
    expect(scanCodexRefreshEvidence('refresh took 4010 ms').unauthorized).toBe(false);
    expect(scanCodexRefreshEvidence('refresh ok\nrefresh: HTTP/1.1 401').unauthorized).toBe(true);
  });

  it('should find nothing in output that says nothing', () => {
    expect(scanCodexRefreshEvidence('')).toEqual(NO_CODEX_REFRESH_EVIDENCE);
  });
});

describe('mergeCodexRefreshEvidence — evidence split across streams is one answer', () => {
  it('should keep every code either side found, once and in the table’s order, and any 401', () => {
    const merged = mergeCodexRefreshEvidence(
      { codes: ['invalid_grant'], unauthorized: false },
      { codes: ['refresh_token_expired', 'invalid_grant'], unauthorized: true },
    );
    expect(merged).toEqual({ codes: ['refresh_token_expired', 'invalid_grant'], unauthorized: true });
  });

  it('should merge nothing with nothing into nothing', () => {
    expect(mergeCodexRefreshEvidence(NO_CODEX_REFRESH_EVIDENCE, NO_CODEX_REFRESH_EVIDENCE)).toEqual(
      NO_CODEX_REFRESH_EVIDENCE,
    );
  });
});

describe('classifyCodexRefreshFailure — only an unmistakable word condemns a login', () => {
  it('should read the most specific word first', () => {
    expect(classifyCodexRefreshFailure({ codes: ['refresh_token_expired', 'invalid_grant'], unauthorized: true })).toBe(
      'expired',
    );
    expect(classifyCodexRefreshFailure({ codes: ['refresh_token_reused'], unauthorized: false })).toBe('revoked');
    expect(classifyCodexRefreshFailure({ codes: ['refresh_token_invalidated'], unauthorized: false })).toBe('revoked');
    expect(classifyCodexRefreshFailure({ codes: ['invalid_grant'], unauthorized: false })).toBe('rejected');
    expect(classifyCodexRefreshFailure({ codes: [], unauthorized: true })).toBe('rejected');
  });

  it('should not judge the login when the output said nothing it can act on', () => {
    expect(classifyCodexRefreshFailure(NO_CODEX_REFRESH_EVIDENCE)).toBe('transient');
  });
});
