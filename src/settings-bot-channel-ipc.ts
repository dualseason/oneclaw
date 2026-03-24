import { app, ipcMain } from "electron";
import {
  readUserConfig,
  verifyQqbot,
  verifyDingtalk,
  writeUserConfig,
} from "./provider-config";
import {
  extractQqbotConfig,
  isQqbotPluginBundled,
  saveQqbotConfig,
} from "./qqbot-config";
import {
  extractDingtalkConfig,
  isDingtalkPluginBundled,
  saveDingtalkConfig,
  DEFAULT_DINGTALK_SESSION_TIMEOUT_MS,
} from "./dingtalk-config";
import {
  extractWecomConfig,
  isWecomPluginBundled,
  saveWecomConfig,
  verifyWecom,
} from "./wecom-config";
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

interface RegisterSettingsBotChannelIpcDeps {
  runTrackedSettingsAction: RunTrackedSettingsAction;
  writeUserConfigAndRestart: typeof writeUserConfig;
}

function resolveQqbotMissingMessage(): string {
  if (!app.isPackaged) {
    return `QQ Bot bundle not found. Run npm run package:resources to generate resources for ${process.platform}-${process.arch}.`;
  }
  return "QQ Bot bundle is missing. Please reinstall OneClaw.";
}

function resolveDingtalkMissingMessage(): string {
  if (!app.isPackaged) {
    return `DingTalk connector bundle not found. Run npm run package:resources to generate resources for ${process.platform}-${process.arch}.`;
  }
  return "DingTalk connector bundle is missing. Please reinstall OneClaw.";
}

function resolveWecomMissingMessage(): string {
  if (!app.isPackaged) {
    return `WeCom plugin bundle not found. Run npm run package:resources to generate resources for ${process.platform}-${process.arch}.`;
  }
  return "WeCom plugin bundle is missing. Please reinstall OneClaw.";
}

export function registerSettingsBotChannelIpc(
  deps: RegisterSettingsBotChannelIpcDeps,
): void {
  const { runTrackedSettingsAction, writeUserConfigAndRestart } = deps;

  ipcMain.handle("settings:get-qqbot-config", async () => {
    try {
      const config = readUserConfig();
      const bundled = isQqbotPluginBundled();
      return {
        success: true,
        data: {
          ...extractQqbotConfig(config),
          bundled,
          bundleMessage: bundled ? "" : resolveQqbotMissingMessage(),
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  ipcMain.handle("settings:save-qqbot-config", async (_event, params) => {
    const enabled = params?.enabled === true;
    const appId = typeof params?.appId === "string" ? params.appId.trim() : "";
    const clientSecret = typeof params?.clientSecret === "string" ? params.clientSecret.trim() : "";
    const markdownSupport = params?.markdownSupport !== false;
    return runTrackedSettingsAction(
      "save_channel",
      { platform: "qqbot", enabled, markdown_support: markdownSupport },
      async () => {
        try {
          const config = readUserConfig();

          if (!enabled) {
            saveQqbotConfig(config, { enabled: false });
            writeUserConfigAndRestart(config);
            return { success: true };
          }

          if (!appId) {
            return { success: false, message: "Please enter QQ Bot App ID." };
          }
          if (!clientSecret) {
            return { success: false, message: "Please enter QQ Bot Client Secret." };
          }
          if (!isQqbotPluginBundled()) {
            return { success: false, message: resolveQqbotMissingMessage() };
          }

          try {
            await verifyQqbot(appId, clientSecret);
          } catch (err: any) {
            return { success: false, message: err.message || "QQ Bot credential verification failed." };
          }

          saveQqbotConfig(config, {
            enabled: true,
            appId,
            clientSecret,
            markdownSupport,
          });
          writeUserConfigAndRestart(config);
          return { success: true };
        } catch (err: any) {
          return { success: false, message: err.message || String(err) };
        }
      },
    );
  });

  ipcMain.handle("settings:get-dingtalk-config", async () => {
    try {
      const config = readUserConfig();
      const bundled = isDingtalkPluginBundled();
      return {
        success: true,
        data: {
          ...extractDingtalkConfig(config),
          bundled,
          bundleMessage: bundled ? "" : resolveDingtalkMissingMessage(),
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  ipcMain.handle("settings:save-dingtalk-config", async (_event, params) => {
    const enabled = params?.enabled === true;
    const clientId = typeof params?.clientId === "string" ? params.clientId.trim() : "";
    const clientSecret = typeof params?.clientSecret === "string" ? params.clientSecret.trim() : "";
    const rawSessionTimeout = params?.sessionTimeout;
    const sessionTimeout =
      typeof rawSessionTimeout === "number"
        ? rawSessionTimeout
        : typeof rawSessionTimeout === "string"
          ? Number(rawSessionTimeout.trim())
          : DEFAULT_DINGTALK_SESSION_TIMEOUT_MS;

    return runTrackedSettingsAction(
      "save_channel",
      { platform: "dingtalk", enabled, session_timeout: sessionTimeout },
      async () => {
        try {
          const config = readUserConfig();

          if (!enabled) {
            saveDingtalkConfig(config, { enabled: false });
            writeUserConfigAndRestart(config);
            return { success: true };
          }

          if (!clientId) {
            return { success: false, message: "Please enter DingTalk Client ID / AppKey." };
          }
          if (!clientSecret) {
            return { success: false, message: "Please enter DingTalk Client Secret / AppSecret." };
          }
          if (!Number.isFinite(sessionTimeout) || sessionTimeout <= 0) {
            return { success: false, message: "Session timeout must be a positive number." };
          }
          if (!isDingtalkPluginBundled()) {
            return { success: false, message: resolveDingtalkMissingMessage() };
          }

          try {
            await verifyDingtalk(clientId, clientSecret);
          } catch (err: any) {
            return { success: false, message: err.message || "DingTalk credential verification failed." };
          }

          saveDingtalkConfig(config, {
            enabled: true,
            clientId,
            clientSecret,
            sessionTimeout,
          });
          writeUserConfigAndRestart(config);
          return { success: true };
        } catch (err: any) {
          return { success: false, message: err.message || String(err) };
        }
      },
    );
  });

  ipcMain.handle("settings:get-wecom-config", async () => {
    try {
      const config = readUserConfig();
      const bundled = isWecomPluginBundled();
      return {
        success: true,
        data: {
          ...extractWecomConfig(config),
          bundled,
          bundleMessage: bundled ? "" : resolveWecomMissingMessage(),
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  ipcMain.handle("settings:save-wecom-config", async (_event, params) => {
    const enabled = params?.enabled === true;
    const botId = typeof params?.botId === "string" ? params.botId.trim() : "";
    const secret = typeof params?.secret === "string" ? params.secret.trim() : "";
    const dmPolicy = typeof params?.dmPolicy === "string" ? params.dmPolicy.trim() : "";
    const groupPolicy = typeof params?.groupPolicy === "string" ? params.groupPolicy.trim() : "";
    const groupAllowFrom = Array.isArray(params?.groupAllowFrom) ? params.groupAllowFrom : [];

    return runTrackedSettingsAction(
      "save_channel",
      { platform: "wecom", enabled, dm_policy: dmPolicy || undefined, group_policy: groupPolicy || undefined },
      async () => {
        try {
          const config = readUserConfig();

          if (!enabled) {
            saveWecomConfig(config, { enabled: false });
            writeUserConfigAndRestart(config);
            return { success: true };
          }

          if (!botId) {
            return { success: false, message: "Please enter WeCom Bot ID." };
          }
          if (!secret) {
            return { success: false, message: "Please enter WeCom Secret." };
          }
          if (!isWecomPluginBundled()) {
            return { success: false, message: resolveWecomMissingMessage() };
          }

          try {
            await verifyWecom(botId, secret);
          } catch (err: any) {
            return { success: false, message: err.message || "WeCom credential verification failed." };
          }

          saveWecomConfig(config, {
            enabled: true,
            botId,
            secret,
            dmPolicy,
            groupPolicy,
            groupAllowFrom,
          });
          writeUserConfigAndRestart(config);
          return { success: true };
        } catch (err: any) {
          return { success: false, message: err.message || String(err) };
        }
      },
    );
  });
}
