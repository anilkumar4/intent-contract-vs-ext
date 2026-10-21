import esbuild from "esbuild";
import fs from "node:fs/promises";

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: watch,
  minify: !watch,
  logLevel: "info"
};
const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
  { ...common, entryPoints: ["src/cli/index.ts"], outfile: "dist/cli.js" },
  { ...common, entryPoints: ["src/mcp/server.ts"], outfile: "dist/mcp-server.js" }
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  process.stdout.write("Watching extension, CLI, and MCP server sources.\n");
} else {
  await Promise.all(["dist/extension.js.map", "dist/cli.js.map", "dist/mcp-server.js.map"].map((file) => fs.rm(file, { force: true })));
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
