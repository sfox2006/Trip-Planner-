// Reproducible pinned local browser SDK; no CDN or runtime dependency fetching.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
const result = await build({
  stdin: {
    contents: 'export {createClient} from "@supabase/supabase-js";',
    resolveDir: process.cwd(),
    sourcefile: "supabase-entry.js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: "vendor/supabase.mjs",
  minify: true,
  legalComments: "eof",
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const packages = [
  ...new Set(
    Object.keys(result.metafile.inputs)
      .filter((p) => p.startsWith("node_modules/"))
      .map((p) => {
        const parts = p.slice("node_modules/".length).split("/");
        return parts[0].startsWith("@")
          ? parts.slice(0, 2).join("/")
          : parts[0];
      }),
  ),
].sort();
const licenses = [];
for (const name of packages) {
  const base = "node_modules/" + name + "/",
    pkg = JSON.parse(await readFile(base + "package.json", "utf8"));
  let license;
  for (const filename of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE-MIT",
    "LICENSE-MIT.txt",
  ]) {
    try {
      license = await readFile(base + filename, "utf8");
      break;
    } catch {}
  }
  if (!license) throw Error("Missing bundled dependency license: " + name);
  licenses.push(name + " " + pkg.version + "\n" + license);
  try {
    licenses.push(await readFile(base + "NOTICE", "utf8"));
  } catch {}
}
await writeFile(
  "vendor/supabase-LICENSES.txt",
  licenses.join("\n\n").replace(/\r\n/g, "\n"),
);
console.log("Bundled pinned SDK and licenses: " + packages.join(", "));
