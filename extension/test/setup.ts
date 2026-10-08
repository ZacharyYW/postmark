import { afterEach, beforeEach } from 'vitest';
import { installFakeChrome } from './fakeChrome';

beforeEach(() => {
  installFakeChrome();
});

afterEach(async () => {
  const { cleanup } = await import('@testing-library/preact');
  cleanup();
});
