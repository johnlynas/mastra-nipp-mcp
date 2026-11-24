import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/mastra/config.js';

describe('loadConfig', () => {
  it('reads PORTAL_BASE_URL and strips trailing slash', () => {
    process.env.PORTAL_BASE_URL = 'http://localhost:3000/';
    expect(loadConfig().baseUrl).toBe('http://localhost:3000');
  });
});
