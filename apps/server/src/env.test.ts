import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseTrustProxy } from './env';

describe('parseTrustProxy', () => {
  it('is off when unset, empty or "false"', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy(' false ')).toBe(false);
  });
  it('understands true and proxy addresses, and refuses a bare number', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(() => parseTrustProxy('1')).toThrow(/TRUST_PROXY/);
    expect(parseTrustProxy('127.0.0.1,10.0.0.0/8')).toBe('127.0.0.1,10.0.0.0/8');
  });
});

describe('loadConfig', () => {
  const good = { ADMIN_PASSWORD: 'p'.repeat(12), SESSION_SECRET: 's'.repeat(32) };

  it('refuses to start without a password or secret', () => {
    expect(() => loadConfig({}, '/root')).toThrow(/ADMIN_PASSWORD[\s\S]*SESSION_SECRET/);
    expect(() => loadConfig({ ...good, ADMIN_PASSWORD: 'short' }, '/root')).toThrow(
      /ADMIN_PASSWORD/,
    );
    expect(() => loadConfig({ ...good, SESSION_SECRET: 'short' }, '/root')).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => loadConfig({ ...good, TRUST_PROXY: '1' }, '/root')).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...good, PORT: 'abc' }, '/root')).toThrow(/PORT/);
  });

  it('fills in defaults and resolves folders against the project root', () => {
    const c = loadConfig(good, '/root');
    expect(c).toMatchObject({ port: 3210, host: '127.0.0.1', trustProxy: false });
    expect(c.dataDir).toBe(resolve('/root', 'data'));
    expect(c.contentDir).toBe(resolve('/root', 'content'));
    expect(loadConfig({ ...good, DATA_DIR: 'x/y' }, '/root').dataDir).toBe(resolve('/root/x/y'));
  });

  it('treats empty values as unset instead of "any port" / "all interfaces"', () => {
    expect(loadConfig({ ...good, PORT: '', HOST: '' }, '/root')).toMatchObject({
      port: 3210,
      host: '127.0.0.1',
    });
    expect(() => loadConfig({ ...good, PORT: '0' }, '/root')).toThrow(/PORT/);
  });

  it('turns the public demo on only with DEMO_MODE=true', () => {
    expect(loadConfig(good, '/root').demo).toBe(false);
    expect(loadConfig({ ...good, DEMO_MODE: '1' }, '/root').demo).toBe(false);
    expect(loadConfig({ ...good, DEMO_MODE: 'true' }, '/root').demo).toBe(true);
  });

  it('checks the event password: long enough, never the public demo password', () => {
    expect(() => loadConfig({ ...good, EVENT_PASSWORD: 'short' }, '/root')).toThrow(
      /EVENT_PASSWORD/,
    );
    expect(() => loadConfig({ ...good, EVENT_PASSWORD: good.ADMIN_PASSWORD }, '/root')).toThrow(
      /EVENT_PASSWORD must not be the same/,
    );
    const c = loadConfig({ ...good, EVENT_PASSWORD: 'e'.repeat(16), EVENT_DIR: 'ev' }, '/root');
    expect(c).toMatchObject({ eventPassword: 'e'.repeat(16), eventDir: resolve('/root/ev') });
  });
});
