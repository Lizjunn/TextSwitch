const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.cjs',
  timeout: 20000,
  expect: { timeout: 5000 },
  workers: 1,
  reporter: 'list'
});
