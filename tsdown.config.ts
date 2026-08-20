import { defineConfig } from 'tsdown'

/**
 * Modules the browser shell seeds into its own module table and answers by name
 * at materialization time. The bundle must reference them by exact specifier and
 * must NOT contain them: inlining React or cordis here would give the page a
 * second instance of a runtime the shell already owns.
 *
 * Anything not on this list has to be inlined instead, because `require` in the
 * generated factory is the shell's table shim, not Node's resolver — an
 * unanswerable specifier is a guaranteed runtime throw.
 */
const SHELL_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

const shellModule = (specifier: string): boolean => SHELL_MODULES.has(specifier)
const mode = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    name: 'raven-research',
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
    name: 'raven-research/client',
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
      neverBundle: shellModule,
      alwaysBundle: (specifier: string) => !shellModule(specifier),
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
      banner: 'window.__ModuleLoader__.load({ id: "dsh-raven-research", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
