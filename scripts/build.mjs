import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(projectRoot, "dist");
const production = process.env.NODE_ENV !== "development";
const buildId = `snapstack-${Date.now().toString(36)}`;

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "fonts"), { recursive: true });

const shared = {
  bundle: true,
  minify: production,
  sourcemap: true,
  target: "chrome120",
  legalComments: "none",
  define: {
    __SNAPSTACK_BUILD_ID__: JSON.stringify(buildId)
  }
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [resolve(projectRoot, "src/content/index.tsx")],
    outfile: resolve(dist, "content.js"),
    format: "iife"
  }),
  build({
    ...shared,
    entryPoints: [resolve(projectRoot, "src/background.ts")],
    outfile: resolve(dist, "background.js"),
    format: "esm"
  }),
  build({
    ...shared,
    entryPoints: [resolve(projectRoot, "src/popup/index.ts")],
    outfile: resolve(dist, "popup.js"),
    format: "iife"
  })
]);

await Promise.all([
  cp(resolve(projectRoot, "public/manifest.json"), resolve(dist, "manifest.json")),
  cp(resolve(projectRoot, "public/popup.html"), resolve(dist, "popup.html")),
  cp(resolve(projectRoot, "public/icon.svg"), resolve(dist, "icon.svg")),
  cp(resolve(projectRoot, "public/icon128.png"), resolve(dist, "icon128.png")),
  cp(resolve(projectRoot, "public/popup-slab-art.png"), resolve(dist, "popup-slab-art.png")),
  cp(resolve(projectRoot, "public/copy-images-active.svg"), resolve(dist, "copy-images-active.svg")),
  cp(resolve(projectRoot, "public/copy-images-disabled.svg"), resolve(dist, "copy-images-disabled.svg")),
  cp(resolve(projectRoot, "public/drag-handle.svg"), resolve(dist, "drag-handle.svg")),
  cp(resolve(projectRoot, "public/toast-success.svg"), resolve(dist, "toast-success.svg")),
  cp(resolve(projectRoot, "src/styles.css"), resolve(dist, "styles.css")),
  cp(
    resolve(projectRoot, "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2"),
    resolve(dist, "fonts/inter-400.woff2")
  ),
  cp(
    resolve(projectRoot, "node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2"),
    resolve(dist, "fonts/inter-500.woff2")
  ),
  cp(
    resolve(projectRoot, "node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2"),
    resolve(dist, "fonts/inter-600.woff2")
  ),
  cp(
    resolve(projectRoot, "node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2"),
    resolve(dist, "fonts/inter-700.woff2")
  )
]);

const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
manifest.version = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")).version;
await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built SnapStack in ${dist}`);
