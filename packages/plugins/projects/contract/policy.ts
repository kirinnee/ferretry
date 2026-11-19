import { type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** The grant a remote device needs to register or remove a folder as a project. Gate owns the capability vocabulary. */
export const FILESYSTEM = policyRef('capability', 'filesystem');
export const filesystemConfigure: CapabilityDemand = { capability: FILESYSTEM, axis: 'configure' };

/** Audit kinds this plugin adds. */
export const PROJECT_REGISTERED_AUDIT = policyRef('audit', 'project.registered');
export const PROJECT_REMOVED_AUDIT = policyRef('audit', 'project.removed');

/** Listing the folders under the owner's home, for the project picker: a read, so the `use` axis. */
export const filesystemUse: CapabilityDemand = { capability: FILESYSTEM, axis: 'use' };

/** Audit kind for a folder made from the picker. */
export const PROJECT_FOLDER_CREATED_AUDIT = policyRef('audit', 'project.folder-created');

/** Audit kind for a change to which accounts a project uses (ids only, never a token or a key). */
export const PROJECT_ACCOUNTS_AUDIT = policyRef('audit', 'project.accounts-changed');
