#!/usr/bin/env node
// Fails when a workspace package.json pins a dependency, a pnpm override,
// or a Yarn resolution to anything but an exact version, per AGENTS.md's
// pin rule (2026-09-11: "no ~ ^, just strictly a certain version,
// throughout the whole app"). A caret, tilde, or other range lets an
// install drift from what was actually tested, and Dependabot's "bump the
// pin in place" flow only works on a pin. workspace:*, catalog: and link:
// specifiers are exempt: each names another package in this monorepo, or
// a pnpm catalog entry, not a registry version range, so there is no
// install to drift.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(SCRIPT_DIR, "..");

const DEPENDENCY_KEYS = ["dependencies", "devDependencies"];

// A specifier naming another workspace package or a pnpm catalog entry
// rather than a registry version range; there is no version to pin.
const EXEMPT_PREFIXES = ["workspace:", "catalog:", "link:"];

// A bare, exact semver: no range operator (^ ~ > <), no wildcard (* or an
// x/X segment), no "||" union, no "latest" tag -- none of those characters
// can appear in a string this pattern matches.
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether a dependency specifier is exempt (a workspace/catalog/link
 * reference) or an exact, pinned version.
 * @param {unknown} spec
 * @returns {boolean}
 */
export function isPinned(spec) {
  if (typeof spec !== "string" || spec.length === 0) return false;
  if (EXEMPT_PREFIXES.some((prefix) => spec.startsWith(prefix))) return true;
  return EXACT_VERSION_RE.test(spec);
}

/**
 * Every name/spec block this check scans in one manifest: `dependencies`
 * and `devDependencies`, plus pnpm's `pnpm.overrides` and Yarn's top-level
 * `resolutions` -- both rewrite what actually installs for a transitive
 * package, so a floating range there is exactly the drift this check
 * exists to catch, same as an unpinned direct dependency.
 * @param {unknown} manifest parsed package.json content
 * @returns {Array<Record<string, unknown>>}
 */
function pinnableBlocks(manifest) {
  const blocks = DEPENDENCY_KEYS.map((key) => manifest?.[key]);
  blocks.push(manifest?.pnpm?.overrides, manifest?.resolutions);
  return blocks.filter((block) => block && typeof block === "object");
}

/**
 * The offending specifiers in one package.json: its dependencies,
 * devDependencies, pnpm.overrides and resolutions blocks.
 * @param {string} label the file's path, as printed in an offender line
 * @param {unknown} manifest parsed package.json content
 * @returns {string[]} one line per offender, `<label>: <name> "<spec>"`
 */
export function findOffenders(label, manifest) {
  const offenders = [];
  for (const block of pinnableBlocks(manifest)) {
    for (const [name, spec] of Object.entries(block)) {
      if (!isPinned(spec)) offenders.push(`${label}: ${name} "${spec}"`);
    }
  }
  return offenders;
}

/**
 * Every workspace package.json path, relative to `root`: the root itself
 * plus every apps/* and packages/* directory that has one.
 * @param {string} root
 * @returns {string[]}
 */
function workspaceManifestPaths(root) {
  const paths = ["package.json"];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    const entries = readdirSync(groupDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(group, entry.name, "package.json");
      if (existsSync(join(root, manifestPath))) paths.push(manifestPath);
    }
  }
  return paths;
}

/**
 * @param {string[]} _argv unused; kept for the same entry-point shape as the other scripts/*.mjs checks
 * @param {{root?: string}} [opts] injection point for tests
 * @returns {number} process exit code: 0 clean, 1 an offender was found
 */
export function run(_argv, opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const offenders = [];
  for (const manifestPath of workspaceManifestPaths(root)) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    offenders.push(...findOffenders(manifestPath, manifest));
  }
  if (offenders.length > 0) {
    for (const line of offenders) console.error(line);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)));
}
