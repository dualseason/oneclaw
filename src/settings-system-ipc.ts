import { app, ipcMain, session } from "electron";
import * as fs from "fs";
import * as path from "path";
import { resolveGatewayCwd, resolveUserStateDir } from "./constants";
import {
  backupThenClearUserConfig,
  getConfigRecoveryData,
  restoreLastKnownGoodConfigSnapshot,
  restoreUserConfigBackup,
} from "./config-backup";
import {
  readUserConfig,
  writeUserConfig,
} from "./provider-config";
import {
  extractKimiConfig,
  saveKimiPluginConfig,
  isKimiPluginBundled,
  DEFAULT_KIMI_BRIDGE_WS_URL,
} from "./kimi-config";
import { ensureGatewayAuthTokenInConfig } from "./gateway-auth";
import { getLaunchAtLoginState, setLaunchAtLoginEnabled } from "./launch-at-login";
import { installCli, uninstallCli, getCliStatus } from "./cli-integration";
import { readSkillStoreRegistry, writeSkillStoreRegistry } from "./skill-store";
import { resolveOneclawConfigPath } from "./oneclaw-config";
import type * as analytics from "./analytics";

type SettingsActionResult = {
  success: boolean;
  message?: string;
};

type RunTrackedSettingsAction = <T extends SettingsActionResult>(
  action: analytics.SettingsAction,
  props: Record<string, unknown>,
  run: () => Promise<T>,
) => Promise<T>;

interface RegisterSettingsSystemIpcDeps {
  analytics: typeof analytics;
  runTrackedSettingsAction: RunTrackedSettingsAction;
  writeUserConfigAndRestart: typeof writeUserConfig;
}

export function registerSettingsSystemIpc(
  deps: RegisterSettingsSystemIpcDeps,
): void {
  const { analytics, runTrackedSettingsAction, writeUserConfigAndRestart } = deps;

  ipcMain.handle("settings:get-kimi-config", async () => {
    try {
      const config = readUserConfig();
      return { success: true, data: extractKimiConfig(config) };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("settings:save-kimi-config", async (_event, params) => {
    const botToken = typeof params?.botToken === "string" ? params.botToken.trim() : "";
    const enabled = params?.enabled;
    return runTrackedSettingsAction("save_kimi", { enabled }, async () => {
      try {
        const config = readUserConfig();
        config.plugins ??= {};
        config.plugins.entries ??= {};

        if (enabled === false) {
          if (config.plugins.entries["kimi-claw"]) {
            config.plugins.entries["kimi-claw"].enabled = false;
          }
          if (config.plugins.entries["kimi-search"]) {
            config.plugins.entries["kimi-search"].enabled = false;
          }
          writeUserConfigAndRestart(config);
          return { success: true };
        }

        if (!botToken) {
          return { success: false, message: "Kimi Bot Token is required." };
        }
        if (!isKimiPluginBundled()) {
          return { success: false, message: "Kimi plugin bundle is missing. Please reinstall OneClaw." };
        }

        const gatewayToken = ensureGatewayAuthTokenInConfig(config);
        saveKimiPluginConfig(config, {
          botToken,
          gatewayToken,
          wsURL: DEFAULT_KIMI_BRIDGE_WS_URL,
        });
        writeUserConfigAndRestart(config);
        return { success: true };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
  });

  ipcMain.handle("settings:get-advanced", async () => {
    try {
      const config = readUserConfig();
      const launchAtLoginState = getLaunchAtLoginState(app);
      const sessionMemoryEntry = config?.hooks?.internal?.entries?.["session-memory"];
      const sessionMemoryEnabled = sessionMemoryEntry?.enabled !== false;
      return {
        success: true,
        data: {
          browserProfile: config?.browser?.defaultProfile ?? "openclaw",
          imessageEnabled: config?.channels?.imessage?.enabled !== false,
          launchAtLoginSupported: launchAtLoginState.supported,
          launchAtLogin: launchAtLoginState.enabled,
          sessionMemoryEnabled,
          clawHubRegistry: readSkillStoreRegistry(),
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("settings:save-advanced", async (_event, params) => {
    const { browserProfile, imessageEnabled } = params;
    const launchAtLogin =
      typeof params?.launchAtLogin === "boolean" ? params.launchAtLogin : undefined;
    const sessionMemoryEnabled =
      typeof params?.sessionMemoryEnabled === "boolean"
        ? params.sessionMemoryEnabled
        : undefined;
    const clawHubRegistry =
      typeof params?.clawHubRegistry === "string" ? params.clawHubRegistry.trim() : undefined;
    return runTrackedSettingsAction(
      "save_advanced",
      {
        browser_profile: browserProfile,
        imessage_enabled: imessageEnabled,
        launch_at_login: launchAtLogin,
        session_memory: sessionMemoryEnabled,
      },
      async () => {
        try {
          const config = readUserConfig();

          config.browser ??= {};
          config.browser.defaultProfile = browserProfile;

          config.channels ??= {};
          config.channels.imessage ??= {};
          config.channels.imessage.enabled = imessageEnabled;

          if (typeof launchAtLogin === "boolean") {
            setLaunchAtLoginEnabled(app, launchAtLogin);
          }

          if (typeof sessionMemoryEnabled === "boolean") {
            config.hooks ??= {};
            config.hooks.internal ??= { enabled: true, entries: {} };
            config.hooks.internal.enabled = true;
            config.hooks.internal.entries ??= {};
            config.hooks.internal.entries["session-memory"] = {
              enabled: sessionMemoryEnabled,
            };
          }

          if (clawHubRegistry !== undefined) {
            writeSkillStoreRegistry(clawHubRegistry);
          }

          writeUserConfigAndRestart(config);
          return { success: true };
        } catch (err: any) {
          return { success: false, message: err.message || String(err) };
        }
      },
    );
  });

  ipcMain.handle("settings:get-cli-status", async () => {
    try {
      return {
        success: true,
        data: getCliStatus(),
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  ipcMain.handle("settings:install-cli", async () => {
    const result = await installCli();
    if (result.success) {
      analytics.track("cli_installed", { method: "settings" });
    } else {
      analytics.track("cli_install_failed", { method: "settings", error: result.message });
    }
    return result;
  });

  ipcMain.handle("settings:uninstall-cli", async () => {
    const result = await uninstallCli();
    if (result.success) {
      analytics.track("cli_uninstalled", { method: "settings" });
    } else {
      analytics.track("cli_uninstall_failed", { method: "settings", error: result.message });
    }
    return result;
  });

  ipcMain.handle("settings:list-config-backups", async () => {
    try {
      return { success: true, data: getConfigRecoveryData() };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  ipcMain.handle("settings:restore-config-backup", async (_event, params) => {
    const fileName = typeof params?.fileName === "string" ? params.fileName : "";
    try {
      if (!fileName) {
        return { success: false, message: "Backup file name is required." };
      }
      restoreUserConfigBackup(fileName);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  ipcMain.handle("settings:restore-last-known-good", async () => {
    try {
      restoreLastKnownGoodConfigSnapshot();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  ipcMain.handle("settings:get-about-info", async () => {
    const oneClawVersion = app.getVersion();
    let openClawVersion = "unknown";
    try {
      const pkgPath = path.join(resolveGatewayCwd(), "package.json");
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.version) openClawVersion = pkg.version;
    } catch {}
    return { oneClawVersion, openClawVersion };
  });

  ipcMain.handle("settings:reset-config-and-relaunch", async () => {
    try {
      const resetResult = backupThenClearUserConfig();
      const configPath = resetResult.configPath;

      const stateDir = resolveUserStateDir();
      for (const marker of [
        resolveOneclawConfigPath(),
        path.join(stateDir, "openclaw-setup-baseline.json"),
        path.join(stateDir, "openclaw.last-known-good.json"),
      ]) {
        if (fs.existsSync(marker)) {
          fs.unlinkSync(marker);
        }
      }

      try {
        await session.defaultSession.clearStorageData({ storages: ["localstorage"] });
      } catch {}

      app.relaunch();
      setTimeout(() => {
        app.exit(0);
      }, 100);

      return {
        success: true,
        data: {
          configPath,
          backupPath: resetResult.backupPath,
          preservedStateDir: resolveUserStateDir(),
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });
}
