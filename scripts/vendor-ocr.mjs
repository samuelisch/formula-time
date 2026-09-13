#!/usr/bin/env node
// Copies the pinned OCR worker and WASM core out of node_modules, and
// downloads the pinned language data, into apps/web/public/ocr/ so the
// bundle serves them from this origin instead of jsDelivr at runtime.
// Usage: node scripts/vendor-ocr.mjs (run via `pnpm --filter @formula-time/web vendor:ocr`)
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Default oem (OEM.LSTM_ONLY) selects the "-lstm" core variant at
// runtime via SIMD feature detection; pinning this exact file (a
// corePath ending in ".js") bypasses that detection so only one core
// ships, not the three SIMD/relaxed-SIMD/plain variants the library
// picks between.
const CORE_FILE = "tesseract-core-lstm.wasm.js";

// eng.traineddata from the tessdata_fast repository at a pinned commit --
// the integerized fast models, not the multi-megabyte "best" floats --
// gzipped as the worker script expects (it checks the gzip magic number).
const TESSDATA_COMMIT = "87416418657359cb625c412a48b6e1d6d41c29bd";
const TESSDATA_URL = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_COMMIT}/eng.traineddata`;

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webDir = join(repoRoot, "apps/web");
const outDir = join(webDir, "public/ocr");
mkdirSync(outDir, { recursive: true });

const webRequire = createRequire(join(webDir, "package.json"));
const tesseractPkgPath = webRequire.resolve("tesseract.js/package.json");
const workerSrc = webRequire.resolve("tesseract.js/dist/worker.min.js");
const coreSrc = require.resolve(`tesseract.js-core/${CORE_FILE}`, { paths: [tesseractPkgPath] });

/**
 * @param {string} path
 * @returns {string} lowercase hex SHA-256
 */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const report = [];

const workerDest = join(outDir, "worker.min.js");
copyFileSync(workerSrc, workerDest);
report.push(["worker.min.js", workerDest]);

const coreDest = join(outDir, CORE_FILE);
copyFileSync(coreSrc, coreDest);
report.push([CORE_FILE, coreDest]);

const langDest = join(outDir, "eng.traineddata.gz");
const res = await fetch(TESSDATA_URL);
if (!res.ok) {
  throw new Error(`fetching ${TESSDATA_URL} failed: ${res.status} ${res.statusText}`);
}
const traineddata = Buffer.from(await res.arrayBuffer());
writeFileSync(langDest, gzipSync(traineddata, { level: 9 }));
report.push(["eng.traineddata.gz", langDest]);

let total = 0;
for (const [name, path] of report) {
  const size = statSync(path).size;
  total += size;
  console.log(`${name}\t${size}\t${sha256(path)}`);
}
console.log(`total\t${total}`);
