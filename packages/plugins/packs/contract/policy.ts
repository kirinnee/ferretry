import { cap } from '@ferretry/core-gate/contract';

/** Pack mode's grant demands: today's `fleet` capability, the same axes (the routes and the config editor). */
export const packUse = cap('fleet', 'use');
export const packConfigure = cap('fleet', 'configure');
