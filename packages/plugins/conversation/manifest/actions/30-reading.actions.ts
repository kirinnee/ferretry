/** Reading a ferret's conversation (session-reads): its log, messages, reference menus and transcript images, and `fy logs`. */
import { route, verb } from '@ferretry/kernel/manifest';
import { FERRET, FLEET_USE, fragment, READ, SECRETS } from '../kit.ts';

export default fragment({
  routes: [
    route('GET /v1/ferrets/:ferretId/logs', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }), // R265: strong etag over redacted text
    route('GET /v1/ferrets/:ferretId/log-page', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }), // R266 (kept half)
    route('GET /v1/ferrets/:ferretId/log-search', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }),
    route('GET /v1/ferrets/:ferretId/messages', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }), // G41: bounded fragments
    // The composer's reference menus (lead decision Q6): each prefix's owner provides its entries through `reference.catalog`.
    // Ungoverned itself, but each provider's own demand (files, terminals, pages) is asked of the caller before it answers.
    route('GET /v1/ferrets/:ferretId/references', { ...FERRET, ...READ, ...SECRETS, consultsGrants: true }),
    // R267 / G162: an image handle never changes for an append-only transcript, so no `noStore`.
    route('GET /v1/ferrets/:ferretId/transcript-images/:handle', {
      minimum: 'operator',
      caller: 'any',
      ...FLEET_USE,
      ...READ,
      ...SECRETS,
    }),
  ],
  cli: [
    verb('logs', {
      summary: "read a ferret's conversation log",
      args: [{ name: 'id', help: 'session id' }],
      options: [{ flag: '--turn <number>', help: 'read one explicitly bounded transcript turn' }],
    }),
  ],
});
