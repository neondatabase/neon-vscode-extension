import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const context = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: !process.argv.includes('--production'),
  minify: process.argv.includes('--production'),
  logLevel: 'info',
});
if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
