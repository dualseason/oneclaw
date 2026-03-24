/**
 * afterPack.js - electron-builder afterPack hook
 *
 * After electron-builder finishes collecting files (including node_modules pruning)
 * and before signing/installer generation, inject resources/targets/<platform-arch>/
 * into the app bundle so parallel multi-target packaging doesn't overwrite shared output.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { Arch } = require("builder-util");

const INJECT_DIRS = ["runtime", "gateway"];
const REQUIRED_FILES = ["analytics-config.json"];
const OPTIONAL_FILES = ["app-icon.png", "icon.ico", "icon.png"];

function resolveArchName(arch) {
  if (typeof arch === "string") return arch;
  const name = Arch[arch];
  if (typeof name === "string") return name;
  throw new Error(`[afterPack] Unable to resolve arch: ${String(arch)}`);
}

function resolveTargetId(context) {
  const fromEnv = process.env.ONECLAW_TARGET;
  if (fromEnv) return fromEnv;
  const platform = context.electronPlatformName;
  const arch = resolveArchName(context.arch);
  return `${platform}-${arch}`;
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const appOutDir = context.appOutDir;
  const targetId = resolveTargetId(context);

  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const targetBase = path.join(resourcesDir, "resources");
  const sourceBase = path.join(__dirname, "..", "resources", "targets", targetId);
  if (!fs.existsSync(sourceBase)) {
    throw new Error(
      `[afterPack] Missing target resource directory: ${sourceBase}. Run package:resources -- --platform ${platform} --arch ${resolveArchName(context.arch)} first.`,
    );
  }
  console.log(`[afterPack] Using target resources: ${targetId}`);

  for (const name of INJECT_DIRS) {
    const src = path.join(sourceBase, name);
    const dest = path.join(targetBase, name);

    if (!fs.existsSync(src)) {
      throw new Error(`[afterPack] Missing resource directory: ${src}`);
    }

    copyDirSync(src, dest);
    console.log(`[afterPack] Injected ${name}/ -> ${path.relative(appOutDir, dest)}`);
  }

  for (const name of REQUIRED_FILES) {
    const src = path.join(sourceBase, name);
    const dest = path.join(targetBase, name);
    if (!fs.existsSync(src)) {
      throw new Error(`[afterPack] Missing required file: ${src}`);
    }
    fs.copyFileSync(src, dest);
    console.log(`[afterPack] Injected ${name}`);
  }

  for (const name of OPTIONAL_FILES) {
    let src = path.join(sourceBase, name);
    const dest = path.join(targetBase, name);
    if (!fs.existsSync(src)) {
      const assetFallback = path.join(__dirname, "..", "assets", name);
      if (!fs.existsSync(assetFallback)) continue;
      src = assetFallback;
    }
    fs.copyFileSync(src, dest);
    console.log(`[afterPack] Injected ${name}`);
  }

  const arch = resolveArchName(context.arch);
  const gatewayDir = path.join(targetBase, "gateway");
  pruneGatewayModules(gatewayDir, platform, arch);

  const productName = context.packager.appInfo.productFilename;
  replaceNodeBinary(platform, targetBase, productName);
};

function replaceNodeBinary(platform, targetBase, productName) {
  const runtimeDir = path.join(targetBase, "runtime");

  if (platform === "darwin") {
    const nodePath = path.join(runtimeDir, "node");
    if (fs.existsSync(nodePath)) {
      const sizeMB = (fs.statSync(nodePath).size / 1048576).toFixed(1);
      fs.unlinkSync(nodePath);
      console.log(`[afterPack] Removed runtime/node (${sizeMB} MB)`);
    }

    const helperName = `${productName} Helper`;
    const helperRelPath = `Frameworks/${helperName}.app/Contents/MacOS/${helperName}`;
    const proxyScript = [
      "#!/bin/sh",
      "# Proxy script - run Electron Helper binary as Node.js runtime",
      'export ELECTRON_RUN_AS_NODE=1',
      `exec "$(dirname "$0")/../../../${helperRelPath}" "$@"`,
      "",
    ].join("\n");

    fs.writeFileSync(nodePath, proxyScript, "utf-8");
    fs.chmodSync(nodePath, 0o755);
    console.log(`[afterPack] Wrote macOS node proxy script (-> ${helperRelPath})`);
  } else if (platform === "win32") {
    const nodeExePath = path.join(runtimeDir, "node.exe");
    if (fs.existsSync(nodeExePath)) {
      const sizeMB = (fs.statSync(nodeExePath).size / 1048576).toFixed(1);
      fs.unlinkSync(nodeExePath);
      console.log(`[afterPack] Removed runtime/node.exe (${sizeMB} MB)`);
    }

    const npmCmdPath = path.join(runtimeDir, "npm.cmd");
    if (fs.existsSync(npmCmdPath)) {
      const npmScript = buildWindowsElectronProxyScript(productName, "%~dp0node_modules\\npm\\bin\\npm-cli.js");
      fs.writeFileSync(npmCmdPath, npmScript, "utf-8");
      console.log("[afterPack] Rewrote npm.cmd");
    }

    const npxCmdPath = path.join(runtimeDir, "npx.cmd");
    if (fs.existsSync(npxCmdPath)) {
      const npxScript = buildWindowsElectronProxyScript(productName, "%~dp0node_modules\\npm\\bin\\npx-cli.js");
      fs.writeFileSync(npxCmdPath, npxScript, "utf-8");
      console.log("[afterPack] Rewrote npx.cmd");
    }
  }
}

function buildWindowsElectronProxyScript(productName, cliEntryPath) {
  const mainExe = `%~dp0..\\..\\..\\${productName}.exe`;
  const helperExe = `%~dp0..\\..\\..\\${productName} Helper.exe`;
  return [
    "@echo off",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "APP_EXE=${mainExe}"`,
    `set "APP_HELPER=${helperExe}"`,
    'if exist "%APP_HELPER%" (',
    `  "%APP_HELPER%" "${cliEntryPath}" %*`,
    ") else (",
    `  "%APP_EXE%" "${cliEntryPath}" %*`,
    ")",
  ].join("\r\n") + "\r\n";
}

const KOFFI_PLATFORM_MAP = {
  "darwin-x64": "darwin_x64",
  "darwin-arm64": "darwin_arm64",
  "win32-x64": "win32_x64",
  "win32-arm64": "win32_arm64",
};

function pruneGatewayModules(gatewayDir, platform, arch) {
  const modulesDir = path.join(gatewayDir, "node_modules");
  if (!fs.existsSync(modulesDir)) return;

  let removedFiles = 0;
  let removedBytes = 0;

  const koffiBuildsDir = path.join(modulesDir, "koffi", "build", "koffi");
  if (fs.existsSync(koffiBuildsDir)) {
    const keepDir = KOFFI_PLATFORM_MAP[`${platform}-${arch}`];
    for (const entry of fs.readdirSync(koffiBuildsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== keepDir) {
        const dirPath = path.join(koffiBuildsDir, entry.name);
        const { count, bytes } = countFiles(dirPath);
        fs.rmSync(dirPath, { recursive: true, force: true });
        removedFiles += count;
        removedBytes += bytes;
      }
    }
    console.log(`[afterPack] koffi: kept ${keepDir}, removed other platforms`);
  }

  const mapStats = removeByGlob(modulesDir, /\.map$/);
  removedFiles += mapStats.count;
  removedBytes += mapStats.bytes;

  const docStats = removeByGlob(
    modulesDir,
    /^(readme|license|licence|changelog|history|authors|contributors)(\.md|\.txt|\.rst)?$/i,
  );
  removedFiles += docStats.count;
  removedBytes += docStats.bytes;

  const savedMB = (removedBytes / 1048576).toFixed(1);
  console.log(`[afterPack] Prune complete: removed ${removedFiles} files, saved ${savedMB} MB`);
}

function countFiles(dir) {
  let count = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countFiles(p);
      count += sub.count;
      bytes += sub.bytes;
    } else {
      count++;
      try {
        bytes += fs.statSync(p).size;
      } catch {}
    }
  }
  return { count, bytes };
}

function removeByGlob(dir, pattern) {
  let count = 0;
  let bytes = 0;
  walkDir(dir, (filePath) => {
    if (pattern.test(path.basename(filePath))) {
      try {
        bytes += fs.statSync(filePath).size;
        fs.unlinkSync(filePath);
        count++;
      } catch {}
    }
  });
  return { count, bytes };
}

function walkDir(dir, callback) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(p, callback);
    } else {
      callback(p);
    }
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      fs.copyFileSync(real, d);
      fs.chmodSync(d, fs.statSync(real).mode);
    } else {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.statSync(s).mode);
    }
  }
}
