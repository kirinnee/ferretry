import { fakeLessons, lessonsConformance } from '../../contract/testing/index.ts';

lessonsConformance('the in-memory fake', () => fakeLessons());
