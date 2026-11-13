/**
 * Catalogs' policy entries (§7.1), copied from today's `runtime/mounts/{shared-catalogs,catalog-members,catalog-links,
 * catalog-installs}.ts`, the member routes of `catalog-members/shared-routes.ts`, and their audit
 * rules. Gate owns the vocabulary; these are references into it.
 */
import { auditKind, CAPABILITIES } from '@ferretry/core-gate/contract';
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';

export const CAPABILITY = {
  filesystem: CAPABILITIES.filesystem,
  fleet: CAPABILITIES.fleet,
  sharing: CAPABILITIES.sharing,
} as const;

export const USE = {
  filesystem: { capability: CAPABILITY.filesystem, axis: 'use' },
  fleet: { capability: CAPABILITY.fleet, axis: 'use' },
  sharing: { capability: CAPABILITY.sharing, axis: 'use' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const CONFIGURE = {
  filesystem: { capability: CAPABILITY.filesystem, axis: 'configure' },
  fleet: { capability: CAPABILITY.fleet, axis: 'configure' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const NARROW = {
  sharing: { capability: CAPABILITY.sharing, axis: 'use', narrowing: true },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const AUDIT = {
  catalogChanged: auditKind('catalog.changed'),
  catalogExported: auditKind('catalog.exported'),
  catalogLinkChanged: auditKind('catalog.link.changed'),
  catalogLinkCopied: auditKind('catalog.link.copied'),
  catalogLinkEnded: auditKind('catalog.link.ended'),
  catalogLinkMinted: auditKind('catalog.link.minted'),
  catalogLinkMoved: auditKind('catalog.link.moved'),
  catalogMemberCatalogRemoved: auditKind('catalog.member.catalog-removed'),
  catalogMemberJoined: auditKind('catalog.member.joined'),
  catalogMemberKeyRemoved: auditKind('catalog.member.key-removed'),
  catalogMemberPasskeyAdded: auditKind('catalog.member.passkey-added'),
  catalogMemberRenamed: auditKind('catalog.member.renamed'),
  catalogMemberRevoked: auditKind('catalog.member.revoked'),
  catalogMemberUnlocked: auditKind('catalog.member.unlocked'),
  catalogShareEnded: auditKind('catalog.share.ended'),
  catalogShareMinted: auditKind('catalog.share.minted'),
  catalogShareNewPasskeyCleared: auditKind('catalog.share.new-passkey-cleared'),
  catalogShareNewPasskeyMarked: auditKind('catalog.share.new-passkey-marked'),
  fleetConfigured: auditKind('fleet.configured'),
} as const;

export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
export const SKIP_UNRECORDED = { skip: 'not kept in the audit log today' } as const satisfies AuditDeclaration;
export const GUARD_NONE = {
  none: 'signed catalog documents, ids and member labels only; no stored secret value',
} as const satisfies GuardDeclaration;
