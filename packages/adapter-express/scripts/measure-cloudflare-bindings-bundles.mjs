import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = resolve(packageDir, "..", "..");
const fixtureDir = join(packageDir, "test", "cloudflare-bindings-worker");
const packageManagerCli = process.env.npm_execpath;
const sourceAliasValue = '"./src/shims/iconv-lite.cjs"';
const wranglerCliPath = join(packageDir, "node_modules", "wrangler", "bin", "wrangler.js");
const localPackages = [
  { name: "@expressots/shared", directory: join(workspaceDir, "packages", "shared") },
  { name: "@expressots/core", directory: join(workspaceDir, "packages", "core") },
  { name: "@expressots/adapter-express", directory: packageDir },
];
const maxBaseGzipBytes = 205 * 1024;
const maxAddedGzipBytes = 1024;
const relativeCeiling = 1.1;
const temporaryParent = mkdtempSync(join(tmpdir(), "expressots-bindings-bundle-"));
const wranglerOutputDir = join(temporaryParent, "wrangler");

function processFailure(label, result) {
  const details = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
  return new Error(`${label} failed${details ? `\n${details}` : ""}`);
}

function runPnpm(cwd, args, label) {
  if (!packageManagerCli) {
    throw new Error("Run this check through the package's pnpm script");
  }
  const result = spawnSync(process.execPath, [packageManagerCli, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error) {
    throw processFailure(label, result);
  }
  return result;
}

function assertPinnedWrangler() {
  if (!existsSync(wranglerCliPath)) {
    throw new Error(`Package-local Wrangler CLI is missing at ${wranglerCliPath}`);
  }
  const { version } = JSON.parse(
    readFileSync(join(packageDir, "node_modules", "wrangler", "package.json"), "utf8"),
  );
  if (version !== "4.118.0") {
    throw new Error(`Expected package-local Wrangler 4.118.0, found ${version}`);
  }
}

function runWrangler(cwd, args, label) {
  const result = spawnSync(process.execPath, [wranglerCliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(wranglerOutputDir, "logs"),
      WRANGLER_CACHE_DIR: join(wranglerOutputDir, "cache"),
      XDG_CACHE_HOME: join(wranglerOutputDir, "cache"),
      XDG_CONFIG_HOME: join(wranglerOutputDir, "config"),
    },
  });
  if (result.status !== 0 || result.error) {
    throw processFailure(label, result);
  }
}

function packLocalPackage(localPackage, packsDir) {
  const packagePacksDir = join(packsDir, localPackage.name.replace("@expressots/", ""));
  mkdirSync(packagePacksDir, { recursive: true });
  runPnpm(
    localPackage.directory,
    ["pack", "--pack-destination", packagePacksDir],
    `Packing ${localPackage.name}`,
  );
  const tarballs = readdirSync(packagePacksDir).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`Packing ${localPackage.name} produced ${tarballs.length} tarballs`);
  }
  return join(packagePacksDir, tarballs[0]);
}

function writeConsumer(packedPackages, consumerDir) {
  const dependencies = Object.fromEntries(
    Object.entries(packedPackages).map(([name, tarball]) => [
      name,
      `file:${relative(consumerDir, tarball).replaceAll("\\", "/")}`,
    ]),
  );
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "expressots-cloudflare-bindings-bundle-consumer",
        private: true,
        type: "module",
        packageManager: "pnpm@10.14.0",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerDir, "pnpm-workspace.yaml"),
    [
      "overrides:",
      ...Object.entries(dependencies).map(([name, spec]) => `  "${name}": "${spec}"`),
      "",
    ].join("\n"),
  );
  cpSync(join(fixtureDir, "bundle"), join(consumerDir, "bundle"), { recursive: true });
  cpSync(join(fixtureDir, "src"), join(consumerDir, "src"), { recursive: true });

  const sourceConfig = readFileSync(join(fixtureDir, "wrangler.bundle.toml"), "utf8");
  if (!sourceConfig.includes(sourceAliasValue)) {
    throw new Error("Expected iconv-lite alias in bundle config; config drifted");
  }
  const runtimeAliasValue = `"${join(consumerDir, "src", "shims", "iconv-lite.cjs").replaceAll(
    "\\",
    "/",
  )}"`;
  writeFileSync(
    join(consumerDir, "wrangler.bundle.toml"),
    sourceConfig.replace(sourceAliasValue, runtimeAliasValue),
  );
}

function assertLocalPackageGraph(consumerDir, packedPackages) {
  const localNames = new Set(Object.keys(packedPackages));
  const seen = new Set();
  const result = runPnpm(
    consumerDir,
    ["list", ...localNames, "--depth", "Infinity", "--json"],
    "Inspecting packed consumer dependencies",
  );
  const projects = JSON.parse(result.stdout);

  function visit(node) {
    if (node === null || typeof node !== "object") return;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, dependency] of Object.entries(node[section] ?? {})) {
        if (localNames.has(name)) {
          seen.add(name);
          if (typeof dependency.resolved === "string" && !dependency.resolved.startsWith("file:")) {
            throw new Error(
              `Packed consumer resolved ${name} outside the local tarballs: ${dependency.resolved}`,
            );
          }
        }
        visit(dependency);
      }
    }
  }

  for (const project of projects) visit(project);
  const missing = [...localNames].filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`Packed consumer is missing local packages: ${missing.join(", ")}`);
  }
}

function listCodeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listCodeFiles(path);
    return [".js", ".mjs", ".cjs"].includes(extname(path)) ? [path] : [];
  });
}

function measureScenario(name, consumerDir, outDir) {
  const entry = name === "allBindings" ? "all-bindings" : name;
  runWrangler(
    consumerDir,
    [
      "deploy",
      join(consumerDir, "bundle", `${entry}.ts`),
      "--config",
      join(consumerDir, "wrangler.bundle.toml"),
      "--dry-run",
      "--outdir",
      outDir,
    ],
    `Wrangler dry-run for ${name}`,
  );
  const files = listCodeFiles(outDir);
  if (files.length === 0) {
    throw new Error(`Wrangler dry-run for ${name} produced no JavaScript output`);
  }
  const contents = files.map((file) => readFileSync(file));
  return {
    rawBytes: contents.reduce((total, content) => total + content.byteLength, 0),
    gzipBytes: contents.reduce((total, content) => total + gzipSync(content).byteLength, 0),
    appExpressPresent: contents.some((content) => content.toString("utf8").includes("AppExpress")),
  };
}

function withKiB(bytes) {
  return { bytes, kibibytes: bytes / 1024 };
}

let primaryError;

try {
  assertPinnedWrangler();
  const packsDir = join(temporaryParent, "packs");
  const consumerDir = join(temporaryParent, "consumer");
  mkdirSync(packsDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  const packedPackages = Object.fromEntries(
    localPackages.map((localPackage) => [
      localPackage.name,
      packLocalPackage(localPackage, packsDir),
    ]),
  );
  writeConsumer(packedPackages, consumerDir);
  runPnpm(
    consumerDir,
    ["install", "--ignore-scripts", "--prefer-offline", "--config.node-linker=hoisted"],
    "Installing packed consumer",
  );
  assertLocalPackageGraph(consumerDir, packedPackages);

  const measurements = {
    base: measureScenario("base", consumerDir, join(temporaryParent, "base")),
    enabled: measureScenario("enabled", consumerDir, join(temporaryParent, "enabled")),
    allBindings: measureScenario("allBindings", consumerDir, join(temporaryParent, "all-bindings")),
  };
  const base = measurements.base;
  const deltas = Object.fromEntries(
    ["enabled", "allBindings"].map((name) => [
      name,
      {
        raw: withKiB(measurements[name].rawBytes - base.rawBytes),
        gzip: withKiB(measurements[name].gzipBytes - base.gzipBytes),
      },
    ]),
  );
  const failures = [];
  for (const [name, measurement] of Object.entries(measurements)) {
    if (measurement.appExpressPresent) {
      failures.push(`${name} unexpectedly includes AppExpress`);
    }
  }
  if (base.gzipBytes > maxBaseGzipBytes) failures.push("base gzip exceeds 205 KiB");
  for (const name of ["enabled", "allBindings"]) {
    if (deltas[name].gzip.bytes > maxAddedGzipBytes) {
      failures.push(`${name} gzip adds more than 1 KiB`);
    }
    if (measurements[name].gzipBytes > base.gzipBytes * relativeCeiling) {
      failures.push(`${name} exceeds the 110% relative ceiling`);
    }
  }

  process.stdout.write(`${JSON.stringify({ measurements, deltas }, null, 2)}\n`);
  if (failures.length > 0) {
    throw new Error(`Cloudflare binding bundle gate failed: ${failures.join("; ")}`);
  }
} catch (error) {
  primaryError = error;
}

try {
  rmSync(temporaryParent, { recursive: true, force: true });
} catch (cleanupError) {
  if (primaryError) {
    throw new AggregateError([primaryError, cleanupError], "Bundle check and cleanup both failed");
  }
  throw cleanupError;
}

if (primaryError) {
  throw primaryError;
}
