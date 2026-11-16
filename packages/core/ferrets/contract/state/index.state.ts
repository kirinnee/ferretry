import { defineState } from '@ferretry/kernel/contract';

export const FerretIndexFile = defineState({ name: 'index', path: 'index.sqlite', store: 'sqlite-cache', format: 1 });
