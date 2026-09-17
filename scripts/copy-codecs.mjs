// Copies the Squoosh WASM binaries out of node_modules into public/codecs so
// they are served as ordinary static assets. The jSquash emscripten modules are
// then pointed at them via `locateFile`, which keeps the bundler out of the
// business of resolving .wasm files entirely.
import { createRequire } from "node:module";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(root, "public", "codecs");

const BINARIES = [
  ["@jsquash/jpeg", "codec/enc/mozjpeg_enc.wasm"],
  ["@jsquash/webp", "codec/enc/webp_enc.wasm"],
  ["@jsquash/webp", "codec/enc/webp_enc_simd.wasm"],
  ["@jsquash/avif", "codec/enc/avif_enc.wasm"],
  ["@jsquash/avif", "codec/enc/avif_enc.js"],
  ["@jsquash/oxipng", "codec/pkg/squoosh_oxipng_bg.wasm"],
];

function packageRoot(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return join(root, "node_modules", ...name.split("/"));
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  let copied = 0;
  for (const [pkg, relative] of BINARIES) {
    const source = join(packageRoot(pkg), ...relative.split("/"));
    const filename = relative.split("/").pop();
    const destination = join(outputDir, filename);

    try {
      await stat(source);
    } catch {
      console.error(`[codecs] missing ${pkg}/${relative} -- run npm install`);
      process.exitCode = 1;
      continue;
    }

    await copyFile(source, destination);
    copied += 1;
  }

  console.log(`[codecs] copied ${copied}/${BINARIES.length} wasm binaries`);
}

await main();
