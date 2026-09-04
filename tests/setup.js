import { afterEach, beforeEach } from 'vitest';

const ENV_KEYS = ['OPENCLAW_CONFIG_DIR', 'OPENCLAW_DIR', 'OPENCLAW_USAGE_HOST', 'OPENCLAW_USAGE_PORT', 'OPENCLAW_USAGE_PRICING_PATH'];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
