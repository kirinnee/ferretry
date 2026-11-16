import type { RelatedGateway, RelatedMatch, RelatedResponse } from '../../../cli/lib/related.ts';

/** A card as the search lists it; the fields the related lines read. */
export const cardHit = (overrides: Partial<RelatedMatch['hit']> = {}): RelatedMatch['hit'] => ({
  kind: 'card',
  id: 'F303',
  title: 'Work search',
  standing: 'In progress',
  match: { field: 'ask', line: 'make search easy and fast' },
  ferret: null,
  ...overrides,
});

export const askHit = (overrides: Partial<RelatedMatch['hit']> = {}): RelatedMatch['hit'] => ({
  kind: 'ask',
  id: 'A3',
  title: 'Pick a relay',
  standing: 'open',
  match: { field: 'title', line: 'Pick a relay' },
  ferret: 'lizzette',
  ...overrides,
});

/** Conversation's `POST /v1/search/related`, played: `undefined` is a daemon that cannot answer. */
export class FakeRelatedGateway implements RelatedGateway {
  readonly relatedCalls: { request: Parameters<RelatedGateway['related']>[0] }[] = [];
  answer: RelatedResponse | undefined = { matches: [] };

  related(request: Parameters<RelatedGateway['related']>[0]) {
    this.relatedCalls.push({ request });
    if (this.answer === undefined) return Promise.reject(new Error('this daemon has no search yet'));
    return Promise.resolve(this.answer);
  }
}

export class CapturingOutput {
  readonly lines: string[] = [];
  readonly notices: string[] = [];

  success(message: string) {
    this.lines.push(message);
  }

  diagnostic(message: string) {
    this.notices.push(message);
  }
}
