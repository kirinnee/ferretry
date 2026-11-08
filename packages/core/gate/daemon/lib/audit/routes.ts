import type { AuditDetail } from '../../../contract/index.ts';

/**
 * WHICH ROUTES ARE AUDITED, AND WHAT EACH RECORD SAYS (today's `lib/audit/routes.ts` table, copied rule for rule).
 *
 * A descriptor says THAT a route is recorded (`audit: { record: <kind> }`); this table says HOW, keyed by the route's
 * `METHOD path`: which path parameter is the subject, which fixed facts it carries, and which NAMES may be read out of
 * the answer. `Admission.recorded` applies it after the handler, once per call (`recorder.ts`).
 *
 * WHAT A RULE MAY READ IS THE GUARANTEE. A rule names a path parameter to use as the subject and, at most, a list of
 * NAMES out of the response — never the request body, never anything else from the response. That is what makes "no
 * code, token, key or command line" structural here.
 *
 * WHAT IT CANNOT SEE — DECLARED. A call admission refuses never reaches a handler and is not recorded here. And the
 * kernel tells Gate after the handler, so two things today's decorator did BEFORE the handler cannot be done: a
 * device's NAME is not resolved (the record names its id), and today's one rule that chose `detail.action` from the
 * request body (a catalog item version's retirement) keeps its own `detail.action`, today's answer for an unreadable
 * body: the handler has already consumed it. A rule for a route this release no longer serves is not carried; `audited-routes.test.ts` holds every rule to a declared descriptor, and names the few whose route another piece has yet to declare.
 */
export interface AuditedRouteRule {
  readonly method: string;
  readonly path: string;
  readonly event: string;
  /** The event a refused or failed request is recorded as, when it is not `event` — a failed step-up. */
  readonly refusedEvent?: string;
  /** The path parameter that names what the request acted on. */
  readonly subject?: string;
  /** A subject that is the same for every request — the name of the setting a `security.changed` changed. */
  readonly fixedSubject?: string;
  /** When the subject is a device id (today resolved its name first; see above). */
  readonly subjectIsDevice?: true;
  /** Fixed facts about this rule, such as which fleet action it was. */
  readonly detail?: AuditDetail;
  /** A top-level field of a successful JSON response holding a NAME or an array of names, joined into `detail`. */
  readonly responseNames?: string;
  /** Copy the `code` of the refusal into `detail`: the codes are a fixed vocabulary, never text a person typed. */
  readonly refusalCode?: true;
  /** A top-level OBJECT of a successful JSON response whose number and boolean fields are copied into `detail`. */
  readonly responseSettings?: readonly string[];
  /** Named facts out of a successful JSON response: an identifier-shaped string or a finite number only. */
  readonly responseFields?: Readonly<Record<string, readonly string[]>>;
  /** A success is not recorded when this top-level field of the JSON answer names another value. */
  readonly recordOnlyWhen?: { readonly field: string; readonly equals: string | boolean };
  /** A response field holding a configuration file PATH, recorded as the KIND of file only (who declares it). */
  readonly responseConfigKind?: string;
}

export const AUDITED_ROUTES: readonly AuditedRouteRule[] = [
  { method: 'POST', path: '/v1/pair/code', event: 'pairing.code-minted' },
  { method: 'DELETE', path: '/v1/pair/code/:pairingId', event: 'pairing.code-revoked', subject: 'pairingId' },
  {
    method: 'DELETE',
    path: '/v1/pair/devices/:deviceId',
    event: 'device.revoked',
    subject: 'deviceId',
    subjectIsDevice: true,
  },
  { method: 'POST', path: '/v1/push/subscriptions', event: 'push.changed', detail: { action: 'enrol' } },
  {
    method: 'DELETE',
    path: '/v1/push/subscriptions/:pushId',
    event: 'push.changed',
    subject: 'pushId',
    detail: { action: 'remove' },
  },
  { method: 'PATCH', path: '/v1/grants', event: 'grants.changed' },
  {
    method: 'PATCH',
    path: '/v1/pair/devices/:deviceId/grants',
    event: 'grants.changed',
    subject: 'deviceId',
    subjectIsDevice: true,
    detail: { scope: 'device' },
  },
  {
    method: 'PATCH',
    path: '/v1/security',
    event: 'security.changed',
    fixedSubject: 'security-settings',
    responseSettings: ['view', 'settings'],
  },
  // A tunnel changes how other devices reach this machine — a hostname on Cloudflare's edge in front of it
  // — so switching it is kept as a change to the machine's security, beside the settings above.
  { method: 'PUT', path: '/v1/tunnel', event: 'security.changed', fixedSubject: 'tunnel' },
  // A secure-copy rule lets a ferret paste a value it holds without asking each time (docs/secure-copy.md): adding
  // one (the commit of its staged rule, with a passkey bound to it, owner decision !A244), or approving a ferret's plan
  // of them, loosens what agents may do; removing one narrows it. All are kept.
  {
    method: 'POST',
    path: '/v1/copy-rules/stages/:stage/commit',
    event: 'security.changed',
    fixedSubject: 'copy-rule',
    detail: { action: 'added' },
  },
  // Letting rules paste into programs from the owner's own profile loosens what a rule matches (owner decision
  // !A182); the setting it now holds is kept with it.
  {
    method: 'PUT',
    path: '/v1/copy-rules/settings',
    event: 'security.changed',
    fixedSubject: 'copy-rule-settings',
    responseSettings: [],
  },
  // Turning profile targets on is staged now, and its commit (with a passkey bound to what it widens) is the change.
  {
    method: 'POST',
    path: '/v1/copy-rules/settings/stages/:stage/commit',
    event: 'security.changed',
    fixedSubject: 'copy-rule-settings',
    responseSettings: [],
  },
  {
    method: 'DELETE',
    path: '/v1/copy-rules/:ruleId',
    event: 'security.changed',
    subject: 'ruleId',
    detail: { action: 'removed' },
  },
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/copy-plans/:planId/approve',
    event: 'security.changed',
    subject: 'planId',
    detail: { action: 'plan-answered' },
  },
  { method: 'POST', path: '/v1/passkeys', event: 'passkey.registered' },
  {
    method: 'POST',
    path: '/v1/passkeys/registration-window',
    event: 'security.changed',
    fixedSubject: 'passkey-registration-window',
  },
  // A confirmation and an unlock are ACTIVITY, not changes: each is a person proving it is them, and a
  // device can repeat them, so they fold. A refused one is a failed guess and folds like every refusal.
  {
    method: 'POST',
    path: '/v1/step-up',
    event: 'step-up.succeeded',
    refusedEvent: 'step-up.failed',
    detail: { action: 'step-up' },
  },
  {
    method: 'POST',
    path: '/v1/unlock',
    event: 'step-up.succeeded',
    refusedEvent: 'step-up.failed',
    detail: { action: 'unlock' },
  },
  { method: 'POST', path: '/v1/runtimes/proposals', event: 'fleet.configured', detail: { action: 'propose' } },
  {
    method: 'POST',
    path: '/v1/runtimes/clone/forget',
    event: 'fleet.configured',
    detail: { action: 'forget-clone-source' },
  },
  {
    method: 'POST',
    path: '/v1/runtimes/proposals/:proposalId/apply',
    event: 'fleet.configured',
    subject: 'proposalId',
    detail: { action: 'apply' },
  },
  {
    method: 'POST',
    path: '/v1/runtimes/machine/tools/install',
    event: 'fleet.configured',
    detail: { action: 'install-tool' },
  },
  // Installing, or removing, an item from a catalog someone else published (`mounts/catalog-installs.ts`): the
  // item's NAME, never a file, command or secret. `code` says why a refusal was one — a signature that did
  // not verify, a publisher that changed, a file edited here — because those mean different things to a reader.
  {
    method: 'POST',
    path: '/v1/catalog-installs/project',
    event: 'fleet.configured',
    responseNames: 'install.provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-install', scope: 'project' },
  },
  {
    method: 'POST',
    path: '/v1/catalog-installs/runtime',
    event: 'fleet.configured',
    responseNames: 'install.provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-install', scope: 'runtime' },
  },
  {
    method: 'DELETE',
    path: '/v1/catalog-installs/project/:installId',
    event: 'fleet.configured',
    subject: 'installId',
    responseNames: 'provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-remove', scope: 'project' },
  },
  {
    method: 'DELETE',
    path: '/v1/catalog-installs/runtime/:installId',
    event: 'fleet.configured',
    subject: 'installId',
    responseNames: 'provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-remove', scope: 'runtime' },
  },
  // Copying a skill from elsewhere on this machine (`mounts/local-skill-installs.ts`): the skill's NAME, never a
  // file. `code` says why a refusal was one — a source the inventory does not list, a file edited here.
  {
    method: 'POST',
    path: '/v1/skill-installs/local/project',
    event: 'fleet.configured',
    responseNames: 'install.name',
    refusalCode: true,
    detail: { action: 'local-skill-install', scope: 'project' },
  },
  {
    method: 'DELETE',
    path: '/v1/skill-installs/local/project/:installId',
    event: 'fleet.configured',
    subject: 'installId',
    responseNames: 'name',
    refusalCode: true,
    detail: { action: 'local-skill-remove', scope: 'project' },
  },
  {
    method: 'POST',
    path: '/v1/skill-installs/local/runtime',
    event: 'fleet.configured',
    responseNames: 'install.name',
    refusalCode: true,
    detail: { action: 'local-skill-install', scope: 'runtime' },
  },
  {
    method: 'DELETE',
    path: '/v1/skill-installs/local/runtime/:installId',
    event: 'fleet.configured',
    subject: 'installId',
    responseNames: 'name',
    refusalCode: true,
    detail: { action: 'local-skill-remove', scope: 'runtime' },
  },
  // Stopping one of the ferret's processes from the Processes tab: an act on its pane, like Ctrl-C into the
  // Console, counted on the session the same way and never naming which one.
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/processes/:processId/stop',
    event: 'terminal.input',
    subject: 'ferretId',
    detail: { mode: 'process-stop' },
  },
  // Answering a permission prompt is keys into the same pane: counted the same way, never with the choice.
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/permission',
    event: 'terminal.input',
    subject: 'ferretId',
    detail: { mode: 'permission' },
  },
  // So is answering a harness dialog.
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/dialog',
    event: 'terminal.input',
    subject: 'ferretId',
    detail: { mode: 'dialog' },
  },
  // Enter on, or an erase of, the person's own draft in the agent's composer — never with the text.
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/composer',
    event: 'terminal.input',
    subject: 'ferretId',
    detail: { mode: 'composer' },
  },
  { method: 'POST', path: '/v1/secrets/use', event: 'secrets.used', responseNames: 'used' },
  // A login Test spends that login's key once on the operator's account; the login is the subject.
  {
    method: 'POST',
    path: '/v1/logins/:loginId/test',
    event: 'secrets.used',
    subject: 'loginId',
    detail: { action: 'login-test' },
  },
  {
    method: 'POST',
    path: '/v1/secrets',
    event: 'secrets.changed',
    responseNames: 'name',
    detail: { action: 'put' },
  },
  {
    method: 'DELETE',
    path: '/v1/secrets/:name',
    event: 'secrets.changed',
    subject: 'name',
    detail: { action: 'delete' },
  },
  // Accounts and sign-ins (docs/secrets.md) are the same store: every change is kept, by handle or sign-in id only.
  // The default account for a place: the subject is the file, never the place or the account (a place can be a folder).
  {
    method: 'PUT',
    path: '/v1/accounts/defaults',
    event: 'secrets.changed',
    fixedSubject: 'account-defaults',
    detail: { action: 'account-default-put' },
  },
  {
    method: 'PUT',
    path: '/v1/accounts/:id',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'account-put' },
  },
  {
    method: 'POST',
    path: '/v1/accounts/:id/rename',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'account-rename' },
  },
  {
    method: 'DELETE',
    path: '/v1/accounts/:id',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'account-delete' },
  },
  {
    method: 'POST',
    path: '/v1/accounts/:id/sign-ins',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'sign-in-add' },
  },
  {
    method: 'PUT',
    path: '/v1/accounts/sign-ins/:signIn',
    event: 'secrets.changed',
    subject: 'signIn',
    detail: { action: 'sign-in-put' },
  },
  {
    method: 'DELETE',
    path: '/v1/accounts/sign-ins/:signIn',
    event: 'secrets.changed',
    subject: 'signIn',
    detail: { action: 'sign-in-delete' },
  },
  {
    method: 'POST',
    path: '/v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId',
    event: 'secrets.changed',
    subject: 'signIn',
    detail: { action: 'sign-in-recipe-decide' },
  },
  {
    method: 'POST',
    path: '/v1/accounts/:id/merge',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'account-merge' },
  },
  {
    method: 'POST',
    path: '/v1/accounts/:id/apart',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'account-apart' },
  },
  // 2FA keys (docs/secrets.md, "2FA keys"): by account and key id only, never a value. A seed's save is recorded with
  // the proof it took (always a passkey bound to that save) and the new key's id.
  {
    method: 'POST',
    path: '/v1/accounts/:id/factors',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'factor-added' },
    responseFields: { factor: ['id'] },
  },
  {
    method: 'PATCH',
    path: '/v1/accounts/:id/factors/:factor',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'factor-relabelled' },
    responseFields: { factor: ['id'] },
  },
  {
    method: 'DELETE',
    path: '/v1/accounts/:id/factors/:factor',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'factor-removed' },
    responseFields: { factor: ['factor'] },
  },
  {
    method: 'POST',
    path: '/v1/accounts/:id/factors/seed',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'factor-seed-staged' },
    responseFields: { stage: ['stage'] },
    refusalCode: true,
  },
  {
    method: 'POST',
    path: '/v1/accounts/:id/factors/seed/:stage/commit',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'factor-added', proof: 'passkey' },
    responseFields: { factor: ['factor', 'id'] },
    // `mismatch`: the key said it was for another account and the owner saved it here anyway.
    responseSettings: [],
    refusalCode: true,
  },
  {
    method: 'POST',
    path: '/v1/accounts/:id/factors/seed/:stage/confirm-in-app',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'factor-seed-confirm-in-app' },
    responseFields: { stage: ['stage'] },
  },
  {
    method: 'DELETE',
    path: '/v1/accounts/:id/factors/seed/:stage',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'factor-seed-dropped' },
    responseFields: { stage: ['stage'] },
  },
  // Copying secrets to another machine: both ends name the SAME import id as the subject, so the source's
  // record and the target's can be matched up by eye. Names only — the bundle is never read here.
  {
    method: 'POST',
    path: '/v1/secrets/exports/:importId',
    event: 'secrets.used',
    subject: 'importId',
    responseNames: 'names',
    detail: { action: 'clone-export' },
  },
  {
    method: 'POST',
    path: '/v1/secrets/imports/:importId',
    event: 'secrets.changed',
    subject: 'importId',
    responseNames: 'imported',
    detail: { action: 'clone-import' },
  },
  // Catalogs this machine publishes (docs/catalogs.md): ids, names and digests only — never what an item holds.
  // The brief the person read is the item; the log keeps WHICH item and WHICH version left, and where it went.
  {
    method: 'POST',
    path: '/v1/catalogs',
    event: 'catalog.changed',
    detail: { action: 'create' },
    responseFields: { catalogId: ['id'], revision: ['revision'] },
  },
  {
    method: 'PATCH',
    path: '/v1/catalogs/:id',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'update' },
    responseFields: { revision: ['revision'], role: ['role'] },
  },
  { method: 'DELETE', path: '/v1/catalogs/:id', event: 'catalog.changed', subject: 'id', detail: { action: 'delete' } },
  {
    method: 'POST',
    path: '/v1/catalogs/:id/items',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'publish' },
    responseFields: { itemId: ['itemId'], itemVersion: ['itemVersion'], digest: ['digest'], revision: ['revision'] },
  },
  {
    method: 'POST',
    path: '/v1/catalogs/:id/items/:itemId/versions',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'publish' },
    responseFields: { itemId: ['itemId'], itemVersion: ['itemVersion'], digest: ['digest'], revision: ['revision'] },
  },
  {
    method: 'POST',
    path: '/v1/catalog-items/:itemId/versions',
    event: 'catalog.changed',
    subject: 'itemId',
    detail: { action: 'publish' },
    responseFields: {
      itemId: ['itemId'],
      itemVersion: ['itemVersion'],
      catalogIds: ['catalogs', '*', 'catalogId'],
      revisions: ['catalogs', '*', 'revision'],
    },
  },
  {
    method: 'PUT',
    path: '/v1/catalog-items/:itemId/current',
    event: 'catalog.changed',
    subject: 'itemId',
    detail: { action: 'make-current' },
    responseFields: {
      itemId: ['itemId'],
      itemVersion: ['itemVersion'],
      catalogIds: ['catalogs', '*', 'catalogId'],
      revisions: ['catalogs', '*', 'revision'],
    },
  },
  {
    method: 'PATCH',
    path: '/v1/catalog-items/:itemId/versions/:version',
    event: 'catalog.changed',
    subject: 'itemId',
    detail: { action: 'retirement' },
    recordOnlyWhen: { field: 'changed', equals: true },
    responseFields: {
      itemId: ['itemId'],
      itemVersion: ['version'],
      catalogIds: ['catalogs', '*', 'catalogId'],
      revisions: ['catalogs', '*', 'revision'],
    },
  },
  {
    method: 'DELETE',
    path: '/v1/catalogs/:id/items/:itemId',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'withdraw' },
    responseFields: { itemId: ['itemId'], revision: ['revision'] },
  },
  {
    method: 'POST',
    path: '/v1/catalog-items/quick-add',
    event: 'catalog.changed',
    detail: { action: 'publish' },
    recordOnlyWhen: { field: 'outcome', equals: 'added' },
    responseFields: {
      catalogId: ['catalog', 'catalogId'],
      itemId: ['itemId'],
      itemVersion: ['itemVersion'],
      digest: ['digest'],
      revision: ['catalog', 'revision'],
      created: ['catalog', 'created'],
    },
  },
  {
    method: 'POST',
    path: '/v1/catalog-items/quick-add/undo',
    event: 'catalog.changed',
    detail: { action: 'undo' },
    responseFields: { catalogId: ['catalogId'], itemId: ['itemId'], revision: ['revision'], mode: ['mode'] },
  },
  {
    method: 'POST',
    path: '/v1/catalogs/:id/export',
    event: 'catalog.exported',
    subject: 'id',
    responseFields: { revision: ['signedManifest', 'manifest', 'revision'], itemIds: ['items', '*', 'itemId'] },
  },
  // Sharing a catalog (docs/catalogs.md § Members). A mint's answer carries the code and the link, so the rule names
  // the few identifier-shaped facts it keeps and nothing else: never the code, the link or the digest.
  {
    method: 'POST',
    path: '/v1/catalog-shares',
    event: 'catalog.share.minted',
    responseFields: {
      shareId: ['share', 'shareId'],
      memberId: ['share', 'memberId'],
      catalogIds: ['share', 'catalogIds', '*'],
      uses: ['share', 'uses', 'kind'],
      expiresAt: ['share', 'expiresAt'],
      newPasskey: ['share', 'newPasskey'],
    },
  },
  {
    method: 'PUT',
    path: '/v1/catalog-shares/:shareId/new-passkey',
    event: 'catalog.share.new-passkey-marked',
    subject: 'shareId',
    responseFields: { memberId: ['memberId'] },
  },
  {
    method: 'DELETE',
    path: '/v1/catalog-shares/:shareId/new-passkey',
    event: 'catalog.share.new-passkey-cleared',
    subject: 'shareId',
    responseFields: { memberId: ['memberId'] },
  },
  { method: 'DELETE', path: '/v1/catalog-shares/:shareId', event: 'catalog.share.ended', subject: 'shareId' },
  // Links (docs/catalogs.md § Links). The mint's answer carries the URL, which holds the key; the copy's answer is the
  // URL alone. Neither rule names a field that could hold one: ids, the kind and the end only, never the URL, the key,
  // the token or the store's name for the bundle.
  {
    method: 'POST',
    path: '/v1/catalog-links',
    event: 'catalog.link.minted',
    responseFields: {
      linkId: ['link', 'linkId'],
      itemId: ['link', 'itemId'],
      version: ['link', 'version'],
      kind: ['link', 'kind'],
      expiresAt: ['link', 'expiresAt'],
      installCap: ['link', 'installCap'],
      created: ['created'],
    },
  },
  {
    method: 'PUT',
    path: '/v1/catalog-links/:linkId/version',
    event: 'catalog.link.moved',
    subject: 'linkId',
    responseFields: { from: ['movedFrom'], to: ['version'], sequence: ['sequence'] },
  },
  {
    method: 'PATCH',
    path: '/v1/catalog-links/:linkId',
    event: 'catalog.link.changed',
    subject: 'linkId',
    responseFields: { expiresAt: ['expiresAt'], installCap: ['installCap'] },
  },
  { method: 'POST', path: '/v1/catalog-links/:linkId/copy', event: 'catalog.link.copied', subject: 'linkId' },
  {
    method: 'DELETE',
    path: '/v1/catalog-links/:linkId',
    event: 'catalog.link.ended',
    subject: 'linkId',
    responseFields: { state: ['state'] },
  },
  {
    method: 'DELETE',
    path: '/v1/catalog-members/:memberId',
    event: 'catalog.member.revoked',
    subject: 'memberId',
    responseFields: { keysRemoved: ['keysRemoved'], sharesEnded: ['sharesEnded'] },
  },
  { method: 'PATCH', path: '/v1/catalog-members/:memberId', event: 'catalog.member.renamed', subject: 'memberId' },
  {
    method: 'DELETE',
    path: '/v1/catalog-members/:memberId/keys/:keyId',
    event: 'catalog.member.key-removed',
    subject: 'memberId',
    responseFields: { keyId: ['keyId'] },
  },
  {
    method: 'DELETE',
    path: '/v1/catalog-members/:memberId/catalogs/:catalogId',
    event: 'catalog.member.catalog-removed',
    subject: 'memberId',
    responseFields: { catalogId: ['catalogId'] },
  },
  { method: 'POST', path: '/v1/ferrets', event: 'session.opened', detail: { action: 'start' } },
  // A person cutting a ferret off: named by the session, never by the credential it held.
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/revoke-credential',
    event: 'session.credential-revoked',
    subject: 'ferretId',
  },
  // Clean up is a short-lived ferret a person started (docs/pack-mode.md § Clean up).
  {
    method: 'POST',
    path: '/v1/pack/routing/clean-up',
    event: 'session.opened',
    detail: { action: 'routing-clean-up' },
  },
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/fork',
    event: 'session.opened',
    subject: 'ferretId',
    detail: { action: 'fork' },
  },
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/send',
    event: 'agent.prompted',
    subject: 'ferretId',
    detail: { action: 'send' },
  },
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/sends/:sendId/retry',
    event: 'agent.prompted',
    subject: 'ferretId',
    detail: { action: 'send-retry' },
  },
  // Taking a send back can erase it from the agent's composer, and Enter submits it: both change what
  // the agent is told, so both are recorded as prompting it — never with the text.
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/sends/:sendId/cancel',
    event: 'agent.prompted',
    subject: 'ferretId',
    detail: { action: 'send-cancel' },
  },
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/sends/:sendId/enter',
    event: 'agent.prompted',
    subject: 'ferretId',
    detail: { action: 'send-enter' },
  },
  // Rewording or taking back a queued message changes what the agent will be told, so both are recorded
  // as prompting it — never with the text — exactly as a send's own cancel is.
  {
    method: 'PATCH',
    path: '/v1/ferrets/:ferretId/queue/:messageId',
    event: 'agent.prompted',
    subject: 'ferretId',
    detail: { action: 'queue-edit' },
  },
  {
    method: 'DELETE',
    path: '/v1/ferrets/:ferretId/queue/:messageId',
    event: 'agent.prompted',
    subject: 'ferretId',
    detail: { action: 'queue-cancel' },
  },
  {
    method: 'POST',
    path: '/v1/ferrets/:ferretId/answer',
    event: 'agent.prompted',
    subject: 'ferretId',
    detail: { action: 'answer' },
  },
  { method: 'POST', path: '/v1/warden/run', event: 'warden.ran' },
  // An owner's request spends an investigation, so it is recorded as a run of its own kind.
  { method: 'POST', path: '/v1/warden/investigate', event: 'warden.ran', detail: { action: 'investigate' } },
  // Leaving a ferret alone switches its supervision off for a while: a change to how the Warden behaves.
  { method: 'POST', path: '/v1/warden/leave', event: 'warden.configured', detail: { action: 'leave' } },
  { method: 'PATCH', path: '/v1/warden/config', event: 'warden.configured' },
  // The configuration files (docs/config-files.md). Nothing from the body — no path, no text — is
  // recorded: which file changed is the file's own business, and its text may be what was wrong.
  { method: 'PUT', path: '/v1/config/file', event: 'fleet.configured', detail: { action: 'config-write' } },
  { method: 'DELETE', path: '/v1/config/file', event: 'fleet.configured', detail: { action: 'config-remove' } },
  // Each rewrites models-guide.yaml, as an edit through the configuration routes would.
  { method: 'POST', path: '/v1/pack/routing/accept', event: 'fleet.configured', detail: { action: 'routing-accept' } },
  { method: 'POST', path: '/v1/pack/routing/undo', event: 'fleet.configured', detail: { action: 'routing-undo' } },
  {
    method: 'POST',
    path: '/v1/config/confirm',
    event: 'fleet.configured',
    detail: { action: 'config-confirm' },
    responseConfigKind: 'path',
  },
  // Today's `POST /v1/agent/config` rule (`fleet.configured`, `action: agent-config`), one per kernel config tool. A
  // tool's call is told under `POST /v1/tools/<plugin>/<tool>`, and so is a call through `POST /v1/agent/config`: its
  // handler records it as the tool the body names, with that tool's admitted standing (the Dispatcher admits the
  // route with none, so a route record would name nobody: round-3 review N2b).
  {
    method: 'POST',
    path: '/v1/tools/kernel/config_read',
    event: 'fleet.configured',
    detail: { action: 'agent-config' },
  },
  {
    method: 'POST',
    path: '/v1/tools/kernel/config_validate',
    event: 'fleet.configured',
    detail: { action: 'agent-config' },
  },
  {
    method: 'POST',
    path: '/v1/tools/kernel/config_write',
    event: 'fleet.configured',
    detail: { action: 'agent-config' },
  },
];
