import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependency = JSON.parse(await readFile(
  resolve(root, "node_modules/smol-toml/package.json"),
  "utf8",
));
const license = await readFile(
  resolve(root, "node_modules/smol-toml/LICENSE"),
  "utf8",
);

await build({
  entryPoints: [resolve(root, "actions/locale.ts")],
  outfile: resolve(root, "actions/locale.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  legalComments: "none",
  banner: {
    js: `/* Bundled dependency: ${dependency.name} ${dependency.version}\n\n${license.replaceAll("*/", "* /")}*/`,
  },
});
