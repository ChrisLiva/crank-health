import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: false,
  // `bin` points at dist/cli.js, so keep the plain .js extension.
  fixedExtension: false,
  // Our own sources collapse into one file; declared runtime deps stay external
  // so npm resolves them once at install time.
  deps: { onlyBundle: false },
  shims: false,
  outputOptions: {
    banner: '#!/usr/bin/env node',
  },
})
