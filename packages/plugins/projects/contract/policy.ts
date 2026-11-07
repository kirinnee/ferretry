import { type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** The grant a remote device needs to register or remove a folder as a project. Gate owns the capability vocabulary. */
export const FILESYSTEM = policyRef('capability', 'filesystem');
export const filesystemConfigure: CapabilityDemand = { capability: FILESYSTEM, axis: 'configure' };

/** Audit kinds this plugin adds. */
export const PROJECT_REGISTERED_AUDIT = policyRef('audit', 'project.registered');
export const PROJECT_REMOVED_AUDIT = policyRef('audit', 'project.removed');
