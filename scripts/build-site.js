// Explicit public asset allowlist. Never reads localStorage, files or user backups.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cloudConfig } from "../cloud-config.js";
import { configurationReady, configurationShape } from "../sync-provider.js";

const root = fileURLToPath(new URL("../", import.meta.url));
export const PUBLIC_ASSETS = [
  "index.html",
  "styles.css",
  "app.js",
  "model.js",
  "attachments.js",
  "pwa.js",
  "cloud-config.js",
  "sync-model.js",
  "sync-provider.js",
  "sync-store.js",
  "sync-engine.js",
  "sync-ui.js",
  "manifest.webmanifest",
  "assets/compass.svg",
  "assets/icon-180.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "vendor/pdf.mjs",
  "vendor/pdf.worker.mjs",
  "vendor/pdfjs-LICENSE.txt",
  "vendor/supabase.mjs",
  "vendor/supabase-LICENSES.txt",
];
export function cloudCSP(config) {
  if (!configurationShape(config))
    throw Error(
      "Cloud config must contain only the four reviewed fields; never add credentials.",
    );
  if (configurationReady(config)) return `connect-src ${config.projectUrl}`;
  if (
    config.enabled !== false ||
    config.policiesVerified !== false ||
    config.projectUrl ||
    config.publishableKey
  )
    throw Error(
      "Incomplete/unverified cloud configuration. Keep all fields disabled/empty until approved backend checks pass.",
    );
  return "connect-src 'none'";
}
export async function buildSite(destination = path.join(root, "_site")) {
  const connectionPolicy = cloudCSP(cloudConfig);
  const files = [];
  for (const name of PUBLIC_ASSETS) {
    let bytes = await readFile(path.join(root, name));
    if (name === "index.html")
      bytes = Buffer.from(
        bytes
          .toString()
          .replace("connect-src 'none'", connectionPolicy)
          .replace(
            'name="planner-offline-shell" content="development"',
            'name="planner-offline-shell" content="ready"',
          ),
      );
    files.push({
      name,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const worker = await readFile(path.join(root, "sw.js"), "utf8");
  const version = createHash("sha256")
    .update(JSON.stringify(files.map((f) => [f.name, f.sha256])))
    .update(worker)
    .digest("hex");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = path.join(destination, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  await writeFile(
    path.join(destination, "sw.js"),
    `self.__PLANNER_SHELL__ = ${JSON.stringify({ version, assets: files.map((f) => ({ path: f.name, sha256: f.sha256 })) })};\n${worker}`,
  );
  await writeFile(path.join(destination, ".nojekyll"), "");
  return { version, files: [...PUBLIC_ASSETS, "sw.js", ".nojekyll"] };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildSite();
  console.log(
    `Built ${result.files.length} public files. Shell ${result.version.slice(0, 12)}.`,
  );
}
