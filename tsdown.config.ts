import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

interface ClientBuildManifest {
  readonly name: string
}

const manifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as ClientBuildManifest

/**
 * Preserve bare imports for the shell module table without copying its changing
 * baseline roster. The exact-target gate compares the emitted requests with the
 * target's own PLATFORM_MODULES and fails on any unanswerable future import.
 */
const clientExternal = (specifier: string): boolean => specifier.length > 0
  && !specifier.startsWith('.')
  && !specifier.startsWith('/')
  && !specifier.startsWith('\0')
  && !/^[A-Za-z]:[\\/]/.test(specifier)
const mode = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    name: manifest.name,
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
  },
  {
    // The preset installer, shipped as the `dsh-raven-install-preset` bin. Built
    // rather than run through tsx because a bin has to work from a plain install,
    // where no TypeScript loader is present. It imports only Node builtins, so
    // there is nothing to externalize.
    name: `${manifest.name}/install-preset`,
    entry: { 'install-preset': 'scripts/install-preset.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    sourcemap: false,
    minify: false,
  },
  {
    name: `${manifest.name}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    // Not ESM and not an IIFE: the browser module loader evaluates the artifact
    // only to REGISTER a factory, then materializes it later with a synchronous
    // `require` shim it supplies. The banner/intro/footer below are that wrapper.
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    // A `.d.cts` cannot carry the banner and footer, and nothing imports this
    // half's types anyway — the shell loads it by manifest, not by import.
    dts: false,
    // The node half runs first and cleans; a second clean would delete it.
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: clientExternal,
      alwaysBundle: (specifier: string) => !clientExternal(specifier),
    },
    // Not decoration: a dependency written in node idiom reads `process.env`
    // at module scope, and without these the factory throws ReferenceError at boot.
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      'import.meta.env.MODE': JSON.stringify(mode),
      'import.meta.env': JSON.stringify({ MODE: mode }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // `id` is the PACKAGE name, which is what the shell's boot entry keys on —
      // not the Cordis plugin name this module exports.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
