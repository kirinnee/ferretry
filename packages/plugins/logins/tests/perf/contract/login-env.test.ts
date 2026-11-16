import { describe, it } from 'bun:test';
import should from 'should';
import { LoginFileSchema } from '../../../contract/index.ts';

// R6: a login file is judged in linear time, however long a value is. That a value over 4096 characters is refused is
// tests/unit/contract/login-env.test.ts; this file holds only the time.

describe('R6: a login file is judged in linear time', () => {
  const file = (env: Record<string, string>) => ({ harness: 'claude-code', store: 'environment', env });

  for (const character of [':', '@', '=', '%', ' ', ',', '\n', '?', '#', '/', '&', ';', '-', 'e']) {
    it(`should judge a 256 KiB value of ${JSON.stringify(character)} in well under 100 ms, under every kind of name`, () => {
      const value = character.repeat(256 * 1024);
      for (const name of ['GATEWAY_TOKEN', 'GATEWAY_NOTE', 'ANTHROPIC_CUSTOM_HEADERS', 'GATEWAY_URL']) {
        const started = performance.now();
        LoginFileSchema.safeParse(file({ [name]: value }));
        should(performance.now() - started).be.below(100);
      }
    });
  }

  it('should judge 256 KiB of repeated token and address openings in well under 100 ms', () => {
    for (const piece of ['eyJ', 'sk-', 'a://', 'a:b@', '${secret:K}', 'x?k=', 'Bearer ']) {
      const value = piece.repeat(Math.ceil((256 * 1024) / piece.length));
      for (const name of ['GATEWAY_TOKEN', 'GATEWAY_NOTE', 'OTEL_EXPORTER_OTLP_HEADERS']) {
        const started = performance.now();
        LoginFileSchema.safeParse(file({ [name]: value }));
        should(performance.now() - started).be.below(100);
      }
    }
  });
});
