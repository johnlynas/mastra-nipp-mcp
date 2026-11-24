import { afterEach, describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/mastra/config.js';

afterEach(() => {
  delete process.env.PORTAL_BASE_URL;
  delete process.env.MCP_ALLOW_SERVICE_FALLBACK;
  delete process.env.PLATFORM_ORG_ID;
});

describe('loadConfig', () => {
  it('reads PORTAL_BASE_URL and strips trailing slash', () => {
    process.env.PORTAL_BASE_URL = 'http://localhost:3000/';
    expect(loadConfig().baseUrl).toBe('http://localhost:3000');
  });

  describe('phase 1 authz flags', () => {
    it('allows the service-account fallback by default', () => {
      expect(loadConfig().allowServiceFallback).toBe(true);
    });

    it('disables the fallback on MCP_ALLOW_SERVICE_FALLBACK=0', () => {
      process.env.MCP_ALLOW_SERVICE_FALLBACK = '0';
      expect(loadConfig().allowServiceFallback).toBe(false);
    });

    it('keeps the fallback enabled on MCP_ALLOW_SERVICE_FALLBACK=1', () => {
      process.env.MCP_ALLOW_SERVICE_FALLBACK = '1';
      expect(loadConfig().allowServiceFallback).toBe(true);
    });

    it('reads PLATFORM_ORG_ID and strips quotes / inline comments', () => {
      process.env.PLATFORM_ORG_ID = '"cmw_platform" # platform org';
      expect(loadConfig().platformOrgId).toBe('cmw_platform');
    });

    it('defaults PLATFORM_ORG_ID to empty string', () => {
      expect(loadConfig().platformOrgId).toBe('');
    });
  });
});
