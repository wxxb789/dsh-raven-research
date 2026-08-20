import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: false,
  minify: false,
  /**
   * Every Harness package stays external, in the emitted JavaScript and in the
   * emitted types.
   *
   * A profile installs plugins with `nodeLinker: hoisted` and `autoInstallPeers:
   * false` precisely so an out-of-tree plugin's peers fall through to the running
   * installation and every plugin shares ONE cordis instance. Bundling a copy of
   * cordis — or of any service definition whose identity the service store keys
   * on — would give this plugin a second instance whose services the Harness
   * cannot resolve, and the failure would appear as an absent service rather than
   * as a build error.
   */
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
