import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The version the region render call reports (X-Region-Client: workstudio-js/<version>), read from
// the package so a release never reports the one before it.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser.ts',
    app: 'src/app/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2020',
  treeshake: true,
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
