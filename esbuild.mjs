import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info"
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  process.stdout.write("Watching extension sources.\n");
} else {
  await esbuild.build(options);
}
