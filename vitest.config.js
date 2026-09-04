import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'sqlite-source.js',
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
    // Vitest 4 projects 模式下顶层 setupFiles 会被静默忽略，
    // 必须挂在每个 project 的 test 配置里，tests/setup.js 才会真正执行。
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          setupFiles: ['tests/setup.js'],
          include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
          exclude: ['tests/unit/frontend/**'],
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          setupFiles: ['tests/setup.js'],
          include: ['tests/unit/frontend/**/*.test.js'],
        },
      },
    ],
  },
});
