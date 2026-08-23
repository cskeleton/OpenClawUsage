import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createNetServer } from 'net';
import request from 'supertest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { createApp, resolveListenHost, resolveListenPort, startServer } from '../../../server.js';

describe('resolveListenPort', () => {
  it('defaults to 3001', () => {
    expect(resolveListenPort(undefined)).toBe(3001);
    expect(resolveListenPort('')).toBe(3001);
  });

  it('accepts valid ports', () => {
    expect(resolveListenPort('1')).toBe(1);
    expect(resolveListenPort('65535')).toBe(65535);
    expect(resolveListenPort('4123')).toBe(4123);
  });

  it('rejects invalid ports', () => {
    expect(() => resolveListenPort('0')).toThrow(/Invalid OPENCLAW_USAGE_PORT/);
    expect(() => resolveListenPort('65536')).toThrow(/Invalid OPENCLAW_USAGE_PORT/);
    expect(() => resolveListenPort('abc')).toThrow(/Invalid OPENCLAW_USAGE_PORT/);
    expect(() => resolveListenPort('30.1')).toThrow(/Invalid OPENCLAW_USAGE_PORT/);
  });
});

describe('resolveListenHost', () => {
  it('defaults to loopback and accepts a deployment bind address', () => {
    expect(resolveListenHost(undefined)).toBe('127.0.0.1');
    expect(resolveListenHost('')).toBe('127.0.0.1');
    expect(resolveListenHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveListenHost('::1')).toBe('::1');
  });

  it('rejects ambiguous or unsafe host values', () => {
    for (const value of ['localhost', '0.0.0.0; touch /tmp/pwned', '127.0.0.1\n', 'not a host']) {
      expect(() => resolveListenHost(value)).toThrow(/Invalid OPENCLAW_USAGE_HOST/);
    }
  });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

describe('configured listen host is used by the real server', () => {
  it('binds 0.0.0.0 when requested instead of silently using loopback', async () => {
    const port = await freePort();
    const oldPort = process.env.OPENCLAW_USAGE_PORT;
    const oldHost = process.env.OPENCLAW_USAGE_HOST;
    process.env.OPENCLAW_USAGE_PORT = String(port);
    process.env.OPENCLAW_USAGE_HOST = '0.0.0.0';
    const server = startServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      expect(server.address().address).toBe('0.0.0.0');
      await request(`http://127.0.0.1:${port}`).get('/api/health').expect(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (oldPort === undefined) delete process.env.OPENCLAW_USAGE_PORT;
      else process.env.OPENCLAW_USAGE_PORT = oldPort;
      if (oldHost === undefined) delete process.env.OPENCLAW_USAGE_HOST;
      else process.env.OPENCLAW_USAGE_HOST = oldHost;
    }
  });
});

describe('static hosting (dist only)', () => {
  let staticDir;
  let app;

  beforeEach(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'ocu-static-'));
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<html><body>dashboard-marker</body></html>');
    writeFileSync(join(staticDir, 'pricing.html'), '<html><body>pricing-marker</body></html>');
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'window.__ASSET__=1;');
    app = createApp({ staticDir });
  });

  afterEach(() => {
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('GET / returns index.html', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('dashboard-marker');
  });

  it('GET /pricing.html returns pricing page', async () => {
    const res = await request(app).get('/pricing.html').expect(200);
    expect(res.text).toContain('pricing-marker');
  });

  it('serves built assets under /assets', async () => {
    const res = await request(app).get('/assets/app.js').expect(200);
    expect(res.text).toContain('__ASSET__');
  });

  it('does not expose repo files outside dist', async () => {
    await request(app).get('/package.json').expect(404);
    await request(app).get('/server.js').expect(404);
    await request(app).get('/src/main.js').expect(404);
    await request(app).get('/tests/fixtures/MANIFEST.json').expect(404);
  });

  it('unknown page returns 404', async () => {
    await request(app).get('/no-such-page.html').expect(404);
  });

  it('unknown /api/* returns JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist').expect(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('POST /unknown does not return HTML 200', async () => {
    const res = await request(app).post('/unknown').expect(404);
    expect(res.status).toBe(404);
    expect(String(res.headers['content-type'] || '')).not.toMatch(/html/i);
  });

  it('GET /api/health is lightweight and has expected shape', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('openclaw-usage');
    expect(res.body.pid).toBe(process.pid);
    expect('launchId' in res.body).toBe(true);
  });
});
