import { fakeUsage, usageConformance } from '../../contract/testing/index.ts';

usageConformance('fake', () => fakeUsage());
