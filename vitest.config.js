import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'aggregator.js',
        'pricing.js',
        'openclaw-config.js',
        'stats-service.js',
        'server.js',
        'mcp-server.js',
        'src/util.js',
        'src/i18n.js',
        'src/theme.js',
        'src/data-filter.js',
      ],
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
          exclude: ['tests/unit/frontend/**'],
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['tests/unit/frontend/**/*.test.js'],
        },
      },
    ],
  },
});
