import { app, ipcMain, session } from "electron";
import { spawn } from "child_process";
import {
  resolveNodeBin,
  resolveNodeExtraEnv,
  resolveGatewayEntry,
  resolveGatewayCwd,
  resolveResourcesPath,
  resolveUserStateDir,
} from "./constants";
import {
  resolveOneclawConfigPath,
  readOneclawConfig,
  writeOneclawConfig,
} from "./oneclaw-config";
import {
  backupThenClearUserConfig,
  getConfigRecoveryData,
  restoreLastKnownGoodConfigSnapshot,
  restoreUserConfigBackup,
} from "./config-backup";
import {
  verifyProvider,
  verifyFeishu,
  verifyQqbot,
  verifyDingtalk,
  readUserConfig,
  writeUserConfig,
} from "./provider-config";
import { readSkillStoreRegistry, writeSkillStoreRegistry } from "./skill-store";
import {
  readChannelAllowFromStoreEntries as readChannelAllowFromStoreEntriesFromFs,
  writeChannelAllowFromStoreEntries as writeChannelAllowFromStoreEntriesFromFs,
} from "./channel-pairing-store";
import {
  extractKimiConfig,
  saveKimiPluginConfig,
  isKimiPluginBundled,
  DEFAULT_KIMI_BRIDGE_WS_URL,
} from "./kimi-config";
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
  WECOM_CHANNEL_ID,
} from "./wecom-config";
import { ensureGatewayAuthTokenInConfig } from "./gateway-auth";
import { getLaunchAtLoginState, setLaunchAtLoginEnabled } from "./launch-at-login";
import { installCli, uninstallCli, getCliStatus } from "./cli-integration";
import { registerSettingsModelIpc } from "./settings-model-ipc";
import { registerSettingsSystemIpc } from "./settings-system-ipc";
import { registerSettingsBotChannelIpc } from "./settings-bot-channel-ipc";
import * as analytics from "./analytics";
import * as path from "path";
import * as fs from "fs";

type CliRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type PairingRequestView = {
  code: string;
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
};

export type FeishuPairingRequestView = PairingRequestView;

type FeishuAuthorizedEntryView = {
  kind: "user" | "group";
  id: string;
  name: string;
};

type FeishuAliasStore = {
  version: 1;
  users: Record<string, string>;
  groups: Record<string, string>;
};

const FEISHU_CHANNEL = "feishu";
const WILDCARD_ALLOW_ENTRY = "*";
const FEISHU_ALIAS_STORE_FILE = "feishu-allowFrom-aliases.json";
const FEISHU_REJECTED_PAIRING_STORE_FILE = "feishu-rejected-pairing-codes.json";
const FEISHU_FIRST_PAIRING_WINDOW_FILE = "feishu-first-pairing-window.json";
const WECOM_REJECTED_PAIRING_STORE_FILE = "wecom-rejected-pairing-codes.json";
const FEISHU_FIRST_PAIRING_WINDOW_TTL_MS = 10 * 60 * 1000;
const FEISHU_OPEN_API_BASE = "https://open.feishu.cn/open-apis";
const FEISHU_TOKEN_SAFETY_MS = 60_000;

type FeishuFirstPairingWindowState = {
  openedAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
  consumedBy: string;
};

type FeishuTenantTokenCache = {
  appId: string;
  appSecret: string;
  token: string;
  expireAt: number;
};

type FeishuRejectedPairingStore = {
  version: 1;
  codes: string[];
};

let feishuTenantTokenCache: FeishuTenantTokenCache | null = null;

type SettingsActionResult = {
  success: boolean;
  message?: string;
};

// Unified settings action tracking wrapper.
async function runTrackedSettingsAction<T extends SettingsActionResult>(
  action: analytics.SettingsAction,
  props: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const canTrackStructured =
    typeof analytics.trackSettingsActionStarted === "function" &&
    typeof analytics.trackSettingsActionResult === "function";
  if (canTrackStructured) {
    analytics.trackSettingsActionStarted(action, props);
  }
  try {
    const result = await run();
    const latencyMs = Date.now() - startedAt;
    const errorType = result.success
      ? undefined
      : (typeof analytics.classifyErrorType === "function"
        ? analytics.classifyErrorType(result.message)
        : "unknown");
    if (canTrackStructured) {
      analytics.trackSettingsActionResult(action, {
        success: result.success,
        latencyMs,
        errorType,
        props,
      });
    }
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const errorType =
      typeof analytics.classifyErrorType === "function"
        ? analytics.classifyErrorType(err)
        : "unknown";
    if (canTrackStructured) {
      analytics.trackSettingsActionResult(action, {
        success: false,
        latencyMs,
        errorType,
        props,
      });
    }
    throw err;
  }
}

interface SettingsIpcOptions {
  requestGatewayRestart?: () => void;
}

// 婵炲鍔岄崬?Settings 闁烩晝顭堥崣?IPC
export function registerSettingsIpc(opts: SettingsIpcOptions = {}): void {
  // 闁告劖鐟ラ崣鍡涙煀瀹ュ洨鏋傞柛姘唉閸ゆ粓宕濋妸鈺佹闁?gateway闁挎稑鐭傛导鈺呭礂瀹ュ棙鐓€濠?handler 闂侇剚顨嗙槐锟犳煂瀹ュ懏鍎欓悹瀣暟閺?
  const writeUserConfigAndRestart: typeof writeUserConfig = (config) => {
    writeUserConfig(config);
    opts.requestGatewayRestart?.();
  };
  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ鍥亹閹惧啿顤?provider/model 闂佹澘绉堕悿鍡涙晬閸у嵅iKey 闁硅　鏅濋悥婊勬交閺傛寧绀€闁?闁冲厜鍋撻柍鍏夊亾
  registerSettingsModelIpc({
    runTrackedSettingsAction,
    writeUserConfigAndRestart,
  });

  registerSettingsSystemIpc({
    analytics,
    runTrackedSettingsAction,
    writeUserConfigAndRestart,
  });

  registerSettingsBotChannelIpc({
    runTrackedSettingsAction,
    writeUserConfigAndRestart,
  });

  // 闁冲厜鍋撻柍鍏夊亾 濡ょ姴鐭侀惁?API Key闁挎稑鐗嗛ˇ鏌ユ偨?provider-config闁?闁冲厜鍋撻柍鍏夊亾

  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ鍥嫉閳ь剟寮弶鍨€诲ù婊庡亝閺嬪啫顩奸崼顒傜闁哄牆绉存慨鐔虹博椤栨粍妯婇柟韬插€撻懙鎴︽嚐鏉堛劍鐎柣妤€鐗婂﹢浼存晬?闁冲厜鍋撻柍鍏夊亾
  // 闁冲厜鍋撻柍鍏夊亾 濞ｅ洦绻傞悺?provider 闂佹澘绉堕悿?闁冲厜鍋撻柍鍏夊亾

  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ鍥紣閹达缚澹曢梺鏉跨Ф閻?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:get-channel-config", async () => {
    try {
      const config = readUserConfig();
      const feishu = config?.channels?.feishu ?? {};
      const enabled = config?.plugins?.entries?.feishu?.enabled === true;
      const dmPolicy = normalizeDmPolicy(feishu?.dmPolicy, "pairing");
      const allowFrom = normalizeAllowFromEntries(feishu?.allowFrom);
      const dmPolicyOpen = dmPolicy === "open" || allowFrom.includes(WILDCARD_ALLOW_ENTRY);
      const dmScope = normalizeDmScope(config?.session?.dmScope, "main");
      const groupPolicy = normalizeGroupPolicy(feishu?.groupPolicy, "allowlist");
      const groupAllowFrom = normalizeAllowFromEntries(feishu?.groupAllowFrom);
      const topicSessionMode = normalizeTopicSessionMode(feishu?.topicSessionMode, "disabled");
      return {
        success: true,
        data: {
          appId: feishu.appId ?? "",
          appSecret: feishu.appSecret ?? "",
          enabled,
          dmPolicy,
          dmPolicyOpen,
          dmScope,
          groupPolicy,
          groupAllowFrom,
          topicSessionMode,
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 濞ｅ洦绻傞悺銊︼紣閹达缚澹曢梺鏉跨Ф閻ゅ棝鏁嶉崼鐔告殰闁?enabled=false 濞寸姴鎳庨崹蹇涘箲閵忕姷纾婚柛蹇曨劜缁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:save-channel", async (_event, params) => {
    const { appId, appSecret, enabled } = params;
    const dmPolicy = normalizeDmPolicy(
      params?.dmPolicy,
      params?.dmPolicyOpen === true ? "open" : "pairing"
    );
    const dmScopeInput = params?.dmScope;
    const groupPolicy = normalizeGroupPolicy(params?.groupPolicy, "allowlist");
    const groupAllowFrom = normalizeAllowFromEntries(params?.groupAllowFrom);
    const trackedProps = {
      platform: FEISHU_CHANNEL,
      enabled,
      dm_policy: dmPolicy,
      group_policy: groupPolicy,
    };
    return runTrackedSettingsAction("save_channel", trackedProps, async () => {
      if (groupPolicy === "allowlist") {
        const hasInvalidGroupId = groupAllowFrom.some((entry) => !looksLikeFeishuGroupId(entry));
        if (hasInvalidGroupId) {
          return { success: false, message: "Only group IDs starting with oc_ are allowed." };
        }
      }
      try {
        const config = readUserConfig();
        const dmScope = normalizeDmScope(
          dmScopeInput,
          normalizeDmScope(config?.session?.dmScope, "main")
        );
        config.plugins ??= {};
        config.plugins.entries ??= {};

        // 濞寸姴鎳愰々锕傛偨?闁?濞戞挸绉甸悧搴㈩殽鐏炶棄娈堕柟?
        if (enabled === false) {
          config.plugins.entries.feishu = { ...(config.plugins.entries.feishu ?? {}), enabled: false };
          writeUserConfigAndRestart(config);
          // 缂佸倷鑳堕弫銈嗩槹閻愭澘濮涢柡鍐硾閸櫻囨⒒椤撴稈鍋撳鍫禃闂佹澘绉烽崵婊堝礉閵婏箑顥楅柛鎴濇閳ь剚绻勯悰銉╁矗閿濆繒绀夊ù锝呮缁绘岸鎮惧▎蹇撳殥婵炴垵鐗愰崹鍌炲冀閸ヮ亶鍞堕柨娑樼焸濡茶顫㈤姀銈呮濠㈣泛绉烽崵婊堝礉閵婏箑顥楅柛鎴濇閳?
          closeFeishuFirstPairingWindow();
          return { success: true };
        }

        // 濞ｅ洦绻傞悺銊╁礈瀹ュ宕ｉ悹鍥︾閸ょ喖骞?
        try {
          await verifyFeishu(appId, appSecret);
        } catch (err: any) {
          return { success: false, message: err.message || "Feishu credential verification failed." };
        }

        config.plugins.entries.feishu = { enabled: true };
        config.channels ??= {};
        // 濞ｅ洦绻勯弳鈧€圭寮跺﹢浣诡槹閻愭澘濮涚紒娑欑墱閺嗘劗鈧稒顨嗛宀勬晬瀹€鍕級闁稿繐绉甸惁鈥斥枎閳ヨ尙绠介悗娑櫭崵鐔煎箲椤曗偓閸忔﹢骞?dmPolicy/allowFrom 閻熸洖妫涘ú濠冪▔閵忕姰浜?
        const prevFeishu =
          config.channels.feishu && typeof config.channels.feishu === "object"
            ? config.channels.feishu
            : {};
        config.channels.feishu = {
          ...prevFeishu,
          appId,
          appSecret,
        };

        const currentAllowFrom = normalizeAllowFromEntries(config.channels.feishu.allowFrom);
        const allowFromWithoutWildcard = currentAllowFrom.filter((entry) => entry !== WILDCARD_ALLOW_ENTRY);

        if (dmPolicy === "open") {
          config.channels.feishu.dmPolicy = "open";
          config.channels.feishu.allowFrom = dedupeEntries([
            ...allowFromWithoutWildcard,
            WILDCARD_ALLOW_ENTRY,
          ]);
        } else {
          config.channels.feishu.dmPolicy = dmPolicy;
          if (allowFromWithoutWildcard.length > 0) {
            config.channels.feishu.allowFrom = allowFromWithoutWildcard;
          } else {
            delete config.channels.feishu.allowFrom;
          }
        }
        config.channels.feishu.groupPolicy = groupPolicy;
        if (groupAllowFrom.length > 0) {
          config.channels.feishu.groupAllowFrom = groupAllowFrom;
        } else {
          delete config.channels.feishu.groupAllowFrom;
        }

        // 缂佸娴囨禍鐗堝濮樺磭妯堥梻鍛⒒椤洨浠﹂悙鎵壘闁稿繈鍔岄惇?session 闂佹澘绉堕悿鍡涙晬鐏炶偐鐟濋柡鍕靛灦椤ワ絾绋婇敃鈧悺娆撴煀瀹ュ洨鏋傞柕?
        config.session ??= {};
        if (dmScope === "main") {
          delete config.session.dmScope;
          if (Object.keys(config.session).length === 0) {
            delete config.session;
          }
        } else {
          config.session.dmScope = dmScope;
        }
        writeUserConfigAndRestart(config);
        // 濞ｅ洦绻傞悺銊р偓鐟版湰閸ㄦ岸宕ユ惔銏犵樆鐟滅増鎸告晶鐘电驳閺嶎偅娈ｇ紓浣哥摠婵垺锛冮弽顓炲赋缂佹劖顨呰ぐ娑㈡晬瀹€鈧垾妯荤┍濠靛懐鐭岄柛?pairing 濞戞挻姊瑰Λ銈夊箳閸喐缍€闁活潿鍔嶉崺娑㈠籍閼搁潧顤呯€殿喒鍋撻柛姘煎灛閳?
        reconcileFeishuFirstPairingWindow(config);
        return { success: true };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
  });

  if (false) {
  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ?QQ Bot 闂佹澘绉堕悿?闁冲厜鍋撻柍鍏夊亾
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

  // 闁冲厜鍋撻柍鍏夊亾 濞ｅ洦绻傞悺?QQ Bot 闂佹澘绉堕悿鍡涙晬閸喐鏆滈柟?enabled=false 濞寸姴鎳庨崹蹇涘箲閵忕姷纾婚柛蹇曨劜缁?闁冲厜鍋撻柍鍏夊亾
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

          // 濞ｅ洦绻傞悺銊╁礈瀹ュ宕ｉ悹鍥︾閸ょ喖骞?
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
      }
    );
  });

  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ鍥煢婢舵劖瀚熼梺鏉跨Ф閻?闁冲厜鍋撻柍鍏夊亾
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

  // 闁冲厜鍋撻柍鍏夊亾 濞ｅ洦绻傞悺銊╂煢婢舵劖瀚熼梺鏉跨Ф閻ゅ棝鏁嶉崼鐔告殰闁?enabled=false 濞寸姴鎳庨崹蹇涘箲閵忕姷纾婚柛蹇曨劜缁?闁冲厜鍋撻柍鍏夊亾
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

          // 濞ｅ洦绻傞悺銊╁礈瀹ュ宕ｉ悹鍥︾閸ょ喖骞?
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
      }
    );
  });

  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ鍥ㄥ娴ｉ鐟圭€甸偊鍠曟穱濠囨煀瀹ュ洨鏋?闁冲厜鍋撻柍鍏夊亾
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

  // 闁冲厜鍋撻柍鍏夊亾 濞ｅ洦绻傞悺銊﹀娴ｉ鐟圭€甸偊鍠曟穱濠囨煀瀹ュ洨鏋傞柨娑樼墛閺侇噣骞?enabled=false 濞寸姴鎳庨崹蹇涘箲閵忕姷纾婚柛蹇曨劜缁?闁冲厜鍋撻柍鍏夊亾
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

          // 濞ｅ洦绻傞悺銊╁礈瀹ュ宕ｉ悹鍥︾閸ょ喖骞戦鍡欑闂侇剙鐏濋崢銈夊锤韫囨稑甯崇紓鍐惧枛閸熸捇宕楅妷銉﹀€甸悗浣冨閸?gateway 闁告凹鍨版慨鈺傚緞鏉堫偉袝
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
      }
    );
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告帗顨呴崵顓熷娴ｉ鐟圭€甸偊鍠曟穱濠傤嚗閸涱収鍚€闁归潧缍婇崢銈団偓鐢殿攰椤曨剙效閸岋妇绀勯悹?openclaw pairing list闁?闁冲厜鍋撻柍鍏夊亾
  }
  ipcMain.handle("settings:list-wecom-pairing", async () => {
    const listed = await listWecomPairingRequests();
    return {
      success: listed.success,
      data: listed.success ? { requests: listed.requests } : undefined,
      message: listed.message,
    };
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告帗顨呴崵顓熷娴ｉ鐟圭€甸偊鍠曟穱濠傤啅閸欏鎴块柡澶婂暟閺併倝骞嬮摎鍌滅憿缂傚洢鍊涙禍?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:list-wecom-approved", async () => {
    try {
      const config = readUserConfig();
      const wecomConfig = config?.channels?.[WECOM_CHANNEL_ID] ?? {};
      const userEntries = collectApprovedUserIds(
        WECOM_CHANNEL_ID,
        wecomConfig?.allowFrom,
      ).map((id) => ({ kind: "user" as const, id, name: id }));
      const groupEntries = normalizeAllowFromEntries(wecomConfig?.groupAllowFrom)
        .map((id) => ({ kind: "group" as const, id, name: id }));
      const entries: FeishuAuthorizedEntryView[] = [...userEntries, ...groupEntries];
      entries.sort(compareAuthorizedEntry);
      return { success: true, data: { entries } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁圭數鎳撻崳顖涘娴ｉ鐟圭€甸偊鍠曟穱濠囨煀瀹ュ拋鍤犻悹鍥敱閻即鏁嶉崼锝堟巢 openclaw pairing approve闁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:approve-wecom-pairing", async (_event, params) => {
    return approveWecomPairingRequest(params);
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁归攱甯炵划閿嬪娴ｉ鐟圭€甸偊鍠曟穱濠囨煀瀹ュ拋鍤犻悹鍥敱閻即鏁嶉崼鐔告嫳闁革附婢橀幏鐑芥偩?pairing code闁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:reject-wecom-pairing", async (_event, params) => {
    return rejectWecomPairingRequest(params);
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告帞濞€濞呭孩瀵兼担椋庣懝鐎甸偊鍠曟穱濠傤啅閸欏鎴块柡澶婂暟閺併倝骞?缂傚洢鍊涙禍?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:remove-wecom-approved", async (_event, params) => {
    const kind = params?.kind === "group" ? "group" : "user";
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    if (!id) {
      return { success: false, message: "ID is required." };
    }
    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels[WECOM_CHANNEL_ID] ??= {};

      if (kind === "group") {
        const nextGroupAllowFrom = normalizeAllowFromEntries(config.channels[WECOM_CHANNEL_ID].groupAllowFrom)
          .filter((entry) => entry !== id);
        config.channels[WECOM_CHANNEL_ID].groupAllowFrom = nextGroupAllowFrom;
      } else {
        const nextAllowFrom = normalizeAllowFromEntries(config.channels[WECOM_CHANNEL_ID].allowFrom)
          .filter((entry) => entry !== id && entry !== WILDCARD_ALLOW_ENTRY);
        if (nextAllowFrom.length > 0) {
          config.channels[WECOM_CHANNEL_ID].allowFrom = nextAllowFrom;
        } else {
          delete config.channels[WECOM_CHANNEL_ID].allowFrom;
        }

        const nextStoreAllowFrom = readChannelAllowFromStore(WECOM_CHANNEL_ID).filter((entry) => entry !== id);
        writeChannelAllowFromStore(WECOM_CHANNEL_ID, nextStoreAllowFrom);
      }

      writeUserConfigAndRestart(config);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告帗顨呴崵顓燁槹閻愭澘濮涚€垫澘鎳庨鎼佸箥瑜版帒甯抽悗鐢殿攰椤曨剙效閸岋妇绀勯悹?openclaw pairing list闁挎稑鐭傛导鈺呭礂瀹ュ娅㈠璺虹Т閻ゅ嫰鎮抽弶璺ㄦ憼闁稿被鍔屽畷妤冩媼椤曞棛绀?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:list-feishu-pairing", async () => {
    const listed = await listFeishuPairingRequests();
    if (!listed.success) {
      return { success: false, message: listed.message || "Failed to list Feishu pairing requests." };
    }
    return { success: true, data: { requests: listed.requests } };
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告帗顨呴崵顓燁槹閻愭澘濮涚€圭寮跺鍧楀级閸愩劌鐏欓悶娑辩厜缁辨瑩鎮介妸锕€鐓?+ 缂傚洢鍊涙禍浼存晬鐏炶偐鍠橀柛蹇撶墕閻秶绮堥崫鍕閻犲洩顕ч幃鏇犵矓鐢喚绀?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:list-feishu-approved", async () => {
    try {
      const config = readUserConfig();
      const feishuConfig = config?.channels?.feishu ?? {};
      const configEntries = normalizeAllowFromEntries(feishuConfig?.allowFrom);
      const storeEntries = readFeishuAllowFromStore();
      const aliases = readFeishuAliasStore();

      const userEntries = dedupeEntries([...storeEntries, ...configEntries])
        .filter((entry) => entry !== WILDCARD_ALLOW_ENTRY)
        .map((id) => toAuthorizedEntryView("user", id, aliases))
        .sort((a, b) => compareAuthorizedEntry(a, b));

      const groupEntries = normalizeAllowFromEntries(feishuConfig?.groupAllowFrom)
        .map((id) => toAuthorizedEntryView("group", id, aliases))
        .sort((a, b) => compareAuthorizedEntry(a, b));

      const entries: FeishuAuthorizedEntryView[] = [...userEntries, ...groupEntries];
      const enrichedEntries = await enrichFeishuEntryNames(entries, feishuConfig);
      enrichedEntries.sort((a, b) => compareAuthorizedEntry(a, b));
      return { success: true, data: { entries: enrichedEntries } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁圭數鎳撻崳顖涱槹閻愭澘濮涢梺鏉跨Т椤曨喚鎷犻柨瀣勾闁挎稑鐗愰摂?openclaw pairing approve闁挎稑鐬肩划鐑樼▔閳ь剟宕樺▎蹇撳汲 allowlist store闁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:approve-feishu-pairing", async (_event, params) => {
    return approveFeishuPairingRequest(params);
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁归攱甯炵划閿嬵槹閻愭澘濮涢梺鏉跨Т椤曨喚鎷犻柨瀣勾闁挎稑娼祊enclaw 闁哄棗鍊瑰Λ?reject 闁告稒鍨濋幎銈夋晬鐏炵厧鈻忛柣顫妽濠€浼村捶?sidecar 闊洨鏅弳鎰嫚?pairing code闁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:reject-feishu-pairing", async (_event, params) => {
    return rejectFeishuPairingRequest(params);
  });

  // 闁冲厜鍋撻柍鍏夊亾 婵烇綀顕ф慨鐐电礃閵堝牅鍠婇柣褑妫勯幃鏇㈠础閺囩喐钂嬮柣鈺婂櫙缁辨瑦绂掗崨顓炲笒閻犱礁鎽滈崗?ID闁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:add-feishu-group-allow-from", async (_event, params) => {
    const id = String(params?.id ?? "").trim();
    if (!looksLikeFeishuGroupId(id)) {
      return { success: false, message: "Only group IDs starting with oc_ are allowed." };
    }

    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels.feishu ??= {};
      const nextGroupAllowFrom = dedupeEntries([
        ...normalizeAllowFromEntries(config.channels.feishu.groupAllowFrom),
        id,
      ]);
      config.channels.feishu.groupAllowFrom = nextGroupAllowFrom;
      writeUserConfigAndRestart(config);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告帞濞€濞呭孩顦伴悙鏉垮鐎圭寮跺鍧楀级閸愨晜钂嬮柣鈺婂櫙缁辨瑩鎮介妸锕€鐓?缂傚洢鍊涙禍浼存晬?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:remove-feishu-approved", async (_event, params) => {
    const kind = String(params?.kind ?? "").trim().toLowerCase() === "group" ? "group" : "user";
    const id = String(params?.id ?? "").trim();
    if (!id) {
      return { success: false, message: "ID is required." };
    }

    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels.feishu ??= {};

      if (kind === "group") {
        const nextGroupAllowFrom = normalizeAllowFromEntries(config.channels.feishu.groupAllowFrom)
          .filter((entry) => entry !== id);
        if (nextGroupAllowFrom.length > 0) {
          config.channels.feishu.groupAllowFrom = nextGroupAllowFrom;
        } else {
          delete config.channels.feishu.groupAllowFrom;
        }
        removeFeishuAlias("group", id);
        writeUserConfigAndRestart(config);
        return { success: true };
      }

      const nextAllowFrom = normalizeAllowFromEntries(config.channels.feishu.allowFrom)
        .filter((entry) => entry !== id);
      if (nextAllowFrom.length > 0) {
        config.channels.feishu.allowFrom = nextAllowFrom;
      } else {
        delete config.channels.feishu.allowFrom;
      }

      const nextStoreAllowFrom = readFeishuAllowFromStore().filter((entry) => entry !== id);
      writeFeishuAllowFromStore(nextStoreAllowFrom);
      removeFeishuAlias("user", id);
      writeUserConfigAndRestart(config);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ?Kimi 闁圭粯甯婂▎銏ゆ煀瀹ュ洨鏋?闁冲厜鍋撻柍鍏夊亾

  // 闁冲厜鍋撻柍鍏夊亾 濞ｅ洦绻傞悺?Kimi 闁圭粯甯婂▎銏ゆ煀瀹ュ洨鏋傞柨娑樼墛閺侇噣骞?enabled=false 濞寸姴鎳庨崹蹇涘箲閵忕姷纾婚柛蹇曨劜缁?闁冲厜鍋撻柍鍏夊亾
  if (false) {
  ipcMain.handle("settings:save-kimi-config", async (_event, params) => {
    const botToken = typeof params?.botToken === "string" ? params.botToken.trim() : "";
    const enabled = params?.enabled;
    return runTrackedSettingsAction("save_kimi", { enabled }, async () => {
      try {
        const config = readUserConfig();
        config.plugins ??= {};
        config.plugins.entries ??= {};

        // 濞寸姴鎳愰々锕傛偨?闁?濞戞挸绉甸悧搴㈩殽?token
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
          return { success: false, message: "Please provide Kimi Bot Token." };
        }
        if (!isKimiPluginBundled()) {
          return { success: false, message: "Kimi channel bundle is missing. Please reinstall OneClaw." };
        }

        const gatewayToken = ensureGatewayAuthTokenInConfig(config);
        saveKimiPluginConfig(config, { botToken, gatewayToken, wsURL: DEFAULT_KIMI_BRIDGE_WS_URL });
        writeUserConfigAndRestart(config);
        return { success: true };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
  });


  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ鍥殗濡ジ鐛撻梺鏉跨Ф閻ゅ棝鏁嶉崸鍞昽wser profile + iMessage闁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:get-advanced", async () => {
    try {
      const config = readUserConfig();
      const launchAtLoginState = getLaunchAtLoginState(app);
      // session-memory hook闁挎稒纰嶅﹢顓㈡煀瀹ュ洨鏋傞弶鈺佹穿椤绋夐崫鍕；闁告凹鍨界槐娆戔偓娑欙耿閸ｆ椽鎮介妸锕€鐓曞娑欘焾椤撹顕ｉ埀顒勫触椤栥倗绀?
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

  // 闁冲厜鍋撻柍鍏夊亾 濞ｅ洦绻傞悺銊︻殗濡ジ鐛撻梺鏉跨Ф閻?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:save-advanced", async (_event, params) => {
    const { browserProfile, imessageEnabled } = params;
    const launchAtLogin = typeof params?.launchAtLogin === "boolean" ? params.launchAtLogin : undefined;
    const sessionMemoryEnabled = typeof params?.sessionMemoryEnabled === "boolean" ? params.sessionMemoryEnabled : undefined;
    const clawHubRegistry = typeof params?.clawHubRegistry === "string" ? params.clawHubRegistry.trim() : undefined;
    return runTrackedSettingsAction(
      "save_advanced",
      { browser_profile: browserProfile, imessage_enabled: imessageEnabled, launch_at_login: launchAtLogin, session_memory: sessionMemoryEnabled },
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

          // 闁告劖鐟ラ崣?session-memory hook 鐎殿喒鍋撻柛?
          if (typeof sessionMemoryEnabled === "boolean") {
            config.hooks ??= {};
            config.hooks.internal ??= { enabled: true, entries: {} };
            config.hooks.internal.enabled = true;
            config.hooks.internal.entries ??= {};
            config.hooks.internal.entries["session-memory"] = { enabled: sessionMemoryEnabled };
          }

          // SkillHub Registry URL 闁告劖鐟ラ崣鍡涙偑椤掑倻褰岄柡鍌氭矗濞嗐垽鏁嶉崼婊呯憹婵厜鍓濋悡?gateway config闁?
          if (clawHubRegistry !== undefined) {
            writeSkillStoreRegistry(clawHubRegistry);
          }

          writeUserConfigAndRestart(config);
          return { success: true };
        } catch (err: any) {
          return { success: false, message: err.message || String(err) };
        }
      }
    );
  });

  // 闁冲厜鍋撻柍鍏夊亾 閻犲洩顕цぐ?CLI 闁绘鍩栭埀顑跨筏缁辨獔nabled=闁活潿鍔嶉崺娑㈠磻韫囨挶鍋ㄩ柨娑橆吙nstalled=鐟滅増鎸告晶?闁哄唲鍛暭 wrapper 閻℃帒鐤囬幎妤呮晬?闁冲厜鍋撻柍鍏夊亾
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

  // 闁冲厜鍋撻柍鍏夊亾 閻庣懓顦抽ˉ?CLI闁挎稑鐗愰埀顑胯兌閺併倝骞嬮悿顖滆缂佸顕ч崣鍡涘矗閿濆繒绀夊娑欘焾椤撶粯绋夊澶嬧枎闁哄偆鍘奸崣鍓р偓鐟板暢椤旀洜绱旈鐣屻偊缂佸顑戠槐?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:install-cli", async () => {
    const result = await installCli();
    if (result.success) {
      analytics.track("cli_installed", { method: "settings" });
    } else {
      analytics.track("cli_install_failed", { method: "settings", error: result.message });
    }
    return result;
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告鐡曞ù?CLI闁挎稑鐗忎簺闂?wrapper + PATH 婵炲鍔岄崣鍡涘锤濡ゅ绀?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:uninstall-cli", async () => {
    const result = await uninstallCli();
    if (result.success) {
      analytics.track("cli_uninstalled", { method: "settings" });
    } else {
      analytics.track("cli_uninstall_failed", { method: "settings", error: result.message });
    }
    return result;
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁告帗顨呴崵顓㈡煀瀹ュ洨鏋傚璺烘矗閸炪倖绋夋惔顫垝濠㈣泛绉撮崢鎾诲极閻楀牆绁?闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:list-config-backups", async () => {
    try {
      return { success: true, data: getConfigRecoveryData() };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 濞寸姴瀛╃€垫氨鈧鑹鹃ˇ顒佺閼恒儲鐎ù鐘哄煐娴狀喗寰勫澶婂赋缂?闁冲厜鍋撻柍鍏夊亾
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

  // 闁冲厜鍋撻柍鍏夊亾 濞戞挴鍋撻梺娆惧枟娴狀喗寰勫鍡樹粯閺夆晜鍨崇粩鏉戔枎閳ュ啿璁查柛姘煎灠婵晞绠涢銈呭季 闁冲厜鍋撻柍鍏夊亾
  ipcMain.handle("settings:restore-last-known-good", async () => {
    try {
      restoreLastKnownGoodConfigSnapshot();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // 闁冲厜鍋撻柍鍏夊亾 闁诡厹鍨归ˇ鏌ユ煀瀹ュ洨鏋傞柨娑欒壘閸樻稒寰勯崶锕€鏁?openclaw.json闁挎稑鑻崯鈧繛鎾虫噽閳规牠鐛崼鏇炴闁告凹鍨扮花鏌ユ偨椤帞绀勫ǎ鍥ㄧ箘閺嗏偓闁告ê妫楄ぐ鍫曟儎椤旇偐绉块柨?闁冲厜鍋撻柍鍏夊亾
  // 閺夆晜鏌ㄥú?OneClaw 闁?OpenClaw 闁绘鐗婂﹢鐗堢┍閳╁啩绱?
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

      // 闁告帞濞€濞呭酣骞嶉埀顒勫嫉婢跺﹤顨涢柛?detectOwnership() 闁告帇鍊曢悾楣冩儍閸曨剛鍨奸悹浣哄閺嬪啯绂掔拋鍦缁绢収鍠曠换姘舵煂瀹ュ懏鍎欓柛姘唉缁绘﹢宕?Setup
      const stateDir = resolveUserStateDir();
      for (const marker of [
        resolveOneclawConfigPath(),                                   // "oneclaw" 鐟滅増甯掗惈姗€寮介崶顏嶅敹
        path.join(stateDir, "openclaw-setup-baseline.json"),          // "legacy-oneclaw" 闁哄秴娲╅?
        path.join(stateDir, "openclaw.last-known-good.json"),         // last-known-good 闊浂鍋嗛崣?
      ]) {
        if (fs.existsSync(marker)) {
          fs.unlinkSync(marker);
        }
      }

      // 婵炴挸鎳樺▍?BrowserWindow 闁?localStorage闁挎稑鐗嗛崹搴㈢椤愩垼鍓ㄧ紒鎰殙椤撴悂寮弶鎸庣彜缂佹稑顧€缁辨岸鏁嶅畝鈧垾妯荤┍濠靛洣鍒掑璺虹Т閸ゎ參宕㈤崒姘€甸柣妯垮煐閳ь兛绀佹禍銈嗘償閺囥垹娅㈢紓?
      try {
        await session.defaultSession.clearStorageData({ storages: ["localstorage"] });
      } catch {
        // 婵炴挸鎳愰幃濠冨緞鏉堫偉袝濞戞挸绉瑰Ο鍡樼箙閻愬搫娅㈤柛?
      }

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
}

// 閻犲洩顕цぐ鍥亹閹惧啿顤呭瀣仒閸旂喖鏌婂鍜佸殸婵☆垪鈧磭纭€闁绘鍩栭埀顑跨筏缁辨繃绗熷☉妤€鐦滈弶鈺傜〒閳诲吋娼娆惧殑闁革絻鍔岄崹浠嬪棘椤撶喐笑闁告熬绠撳〒鍓佹啺娴ｇ儤鍩涚紓渚囧幘濞插啴宕ラ閿亾?
export function getFeishuPairingModeState(): {
  enabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist";
  approvedUserCount: number;
} {
  const config = readUserConfig();
  const feishu = config?.channels?.feishu ?? {};
  const enabled = config?.plugins?.entries?.feishu?.enabled === true;
  const dmPolicy = normalizeDmPolicy(feishu?.dmPolicy, "pairing");
  const approvedUserIds = collectApprovedUserIds(FEISHU_CHANNEL, feishu?.allowFrom);
  return {
    enabled,
    dmPolicy,
    approvedUserCount: approvedUserIds.length,
  };
}

// 閻犲洩顕цぐ鍥亹閹惧啿顤呭ù闂存缁楃喎顕ラ璁崇箚闂佹澘绉撮顔嘉熼垾宕囩闁绘鍩栭埀顑跨筏缁辨繃绗熷☉妤€鐦滈弶鈺傜〒閳诲吋娼娆惧殑闁革絻鍔岄崹浠嬪棘椤撶喐笑闁告熬绠撳〒鍓佹啺娴ｇ儤鍩涚紓渚囧幘濞插啴宕ラ閿亾?
export function getWecomPairingModeState(): {
  enabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist";
  approvedUserCount: number;
} {
  const config = readUserConfig();
  const wecom = config?.channels?.[WECOM_CHANNEL_ID] ?? {};
  const enabled = config?.plugins?.entries?.["wecom-openclaw-plugin"]?.enabled === true;
  const dmPolicy = normalizeDmPolicy(wecom?.dmPolicy, "pairing");
  return {
    enabled,
    dmPolicy,
    approvedUserCount: collectApprovedUserIds(WECOM_CHANNEL_ID, wecom?.allowFrom).length,
  };
}

// 闁告帗顨呴崵顓燁槹閻愭澘濮涚€垫澘鎳庨鎼佸箥绾拋鍤炴慨鐟板亰缁辨壆鎲撮敐鍡欌偓?CLI 閺夊牊鎸搁崵顓㈢嵁閸撲胶鍩犲☉鎾亾闁瑰瓨鍔曟晶鐘电博椤栨艾璁叉繛鎴濈墣閸ㄥ倻绱掗幘瀵糕偓顖炲Υ?
export async function listFeishuPairingRequests(): Promise<{
  success: boolean;
  requests: FeishuPairingRequestView[];
  message?: string;
}> {
  return listChannelPairingRequests(FEISHU_CHANNEL, "Failed to list Feishu pairing requests.", "Failed to parse Feishu pairing request response.");
}

// 闁告帗顨呴崵顓熷娴ｉ鐟圭€甸偊鍠曟穱濠傤嚗閸涱収鍚€闁圭數顢婇顒€效閸岋妇绐楅悷娆欑稻閻?CLI 閺夊牊鎸搁崵顓㈢嵁閸撲胶鍩犲☉鎾亾闁瑰瓨鍔曟晶鐘电博椤栨艾璁叉繛鎴濈墣閸ㄥ倻绱掗幘瀵糕偓顖炲Υ?
export async function listWecomPairingRequests(): Promise<{
  success: boolean;
  requests: PairingRequestView[];
  message?: string;
}> {
  return listChannelPairingRequests(WECOM_CHANNEL_ID, "Failed to list WeCom pairing requests.", "Failed to parse WeCom pairing request response.");
}

// 闁圭數鎳撻崳顖涱槹閻愭澘濮涢梺鏉跨Т椤曨喚鎷犻柨瀣勾闁挎稒淇洪惃鐔兼偨?CLI 妤犵偠娉涘﹢顏堝箣閹邦剙顫犻柛姘捣缁憋妇鈧稒顭囬弫銈夊箣瀹勬澘鐒奸柛姘Ф閺併倖绂嶆惔锛勬綌缂佲偓閹巻鍋?
export async function approveFeishuPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  const id = typeof params?.id === "string" ? params.id.trim() : "";
  const name = typeof params?.name === "string" ? params.name.trim() : "";
  const result = await approveChannelPairingRequest(FEISHU_CHANNEL, params);
  if (result.success && id && name) {
    saveFeishuAlias("user", id, name);
  }
  return result;
}

// 闁圭數鎳撻崳顖涘娴ｉ鐟圭€甸偊鍠曟穱濠囨煀瀹ュ拋鍤犻悹鍥敱閻即鏁嶅宕囨闁?CLI闁挎稑鑻懟鐔煎捶閵婏箑鐏囬柛鏃傚枎閹銆掗崨顖涘€為柡鍫墮濠€鎾箯閹烘梻鍗滈柣顔婚檷閳?
export async function approveWecomPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  return approveChannelPairingRequest(WECOM_CHANNEL_ID, params);
}

// 闁归攱甯炵划閿嬵槹閻愭澘濮涢梺鏉跨Т椤曨喚鎷犻柨瀣勾闁挎稒鑹剧紞瀣礈?openclaw pairing 闁?reject 閻庢稒鍔曢幊鈩冪閵堝繒绀夐柡鈧柅娑滅闁哄牜鍓欏﹢纾嬬疀閻ｅ本娈ｇ憸鐗堟尭婢х娀鏌婂鍜佸殸闁活喕闄嶉埀?
export async function rejectFeishuPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  return rejectChannelPairingRequest(FEISHU_CHANNEL, params);
}

// 闁归攱甯炵划閿嬪娴ｉ鐟圭€甸偊鍠曟穱濠囨煀瀹ュ拋鍤犻悹鍥敱閻即鏁嶅顒傜Ъ闁?openclaw pairing 闁?reject 閻庢稒鍔曢幊鈩冪閵堝繒绀夐柡鈧柅娑滅闁哄牜鍓欏﹢纾嬬疀閻ｅ本娈ｇ憸鐗堟尭婢х娀鏌婂鍜佸殸闁活喕闄嶉埀?
export async function rejectWecomPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  return rejectChannelPairingRequest(WECOM_CHANNEL_ID, params);
}

// 缂備胶鍠嶇粩瀵告喆閿濆棛鈧粙寮婚幇顏堝殝婵炴挾濞€娴滈箖鎯冮崟顐ょ閻庡厜鍓濇竟鎺楀礆濡ゅ嫨鈧啴鏁嶇仦鍊熷珯閺夆晛娲﹂幎銈夊嫉椤掆偓濠€?sidecar 闂佹彃鐬煎▓鎴﹀箯閹烘梻鍗滈柣顔婚檷閳?
async function listChannelPairingRequests(
  channel: string,
  listErrorMessage: string,
  parseErrorMessage: string,
): Promise<{
  success: boolean;
  requests: PairingRequestView[];
  message?: string;
}> {
  try {
    const run = await runGatewayCli(["pairing", "list", channel, "--json"]);
    if (run.code !== 0) {
      return {
        success: false,
        requests: [],
        message: compactCliError(run, listErrorMessage),
      };
    }

    const parsed = parseJsonSafe(run.stdout);
    if (!parsed || !Array.isArray(parsed?.requests)) {
      return {
        success: false,
        requests: [],
        message: compactCliError(run, parseErrorMessage),
      };
    }

    const rawRequests = Array.isArray(parsed?.requests) ? parsed.requests : [];
    const parsedRequests: PairingRequestView[] = rawRequests.map((item: any) => ({
      code: String(item?.code ?? ""),
      id: String(item?.id ?? ""),
      name: String(item?.meta?.name ?? item?.name ?? ""),
      createdAt: String(item?.createdAt ?? ""),
      lastSeenAt: String(item?.lastSeenAt ?? ""),
    }));
    const rejectedCodes = new Set(readRejectedPairingCodes(resolveRejectedPairingStoreFile(channel)));
    const requests = parsedRequests.filter((item) => !rejectedCodes.has(item.code));
    if (rejectedCodes.size > 0) {
      const activeCodes = new Set(parsedRequests.map((item) => item.code));
      pruneRejectedPairingCodes(resolveRejectedPairingStoreFile(channel), activeCodes);
    }
    return { success: true, requests };
  } catch (err: any) {
    return {
      success: false,
      requests: [],
      message: err?.message || String(err),
    };
  }
}

// 缂備胶鍠嶇粩鎾箥瑜戦、鎴濄€掗悩璁冲 pairing approve闁挎稑鐭傛导鈺呭礂瀹ュ棛妲ㄥ☉鎿冧簼缁楊參鏌嗛幘璇叉濠㈣泛绉电€?CLI 闁告瑥鍊归弳鐔煎Υ?
async function approveChannelPairingRequest(
  channel: string,
  params: Record<string, unknown>,
): Promise<{
  success: boolean;
  message?: string;
}> {
  const code = typeof params?.code === "string" ? params.code.trim() : "";
  if (!code) {
    return { success: false, message: "Pairing code is required." };
  }

  try {
    const run = await runGatewayCli(["pairing", "approve", channel, code, "--notify"]);
    if (run.code !== 0) {
      return {
        success: false,
        message: compactCliError(run, `闁圭數鎳撻崳顖炴煀瀹ュ拋鍤犻柣顔荤閵囨垹鎷? ${code}`),
      };
    }
    removeRejectedPairingCode(resolveRejectedPairingStoreFile(channel), code);
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}

// 鐟滅増鎸告晶?openclaw pairing 闁哄棗鍊瑰Λ?reject 閻庢稒鍔曢幊鈩冪閵堝繒绀夐弶鈺傜懇閸ｉ绱掗悢鍓侇伇闁活潿鍔嶅﹢浼村捶?sidecar 闊洨鏅弳鎰亹閹惧啿顤?pairing code闁?
async function rejectChannelPairingRequest(
  channel: string,
  params: Record<string, unknown>,
): Promise<{
  success: boolean;
  message?: string;
}> {
  const code = typeof params?.code === "string" ? params.code.trim() : "";
  if (!code) {
    return { success: false, message: "Pairing code is required." };
  }
  appendRejectedPairingCode(resolveRejectedPairingStoreFile(channel), code);
  return { success: true };
}

// 闁哄秷顫夊畵渚€鏌婂鍥╂瀭濞戞挸瀛╁鍧楀级閸愩劎鎽犻柛灞诲妿缁櫣鎷嬮垾宕囩Ъ闁告挸绉撮崙锟犲箳閸喐缍€闁活潿鍔嶉崺娑㈡晬鐏炴儳绗撻梻鍕╁€濋埀顒佸哺閸樸倗绮敂璺ㄧ憿缂佸苯鎼埀顒傤儠閳?
function collectApprovedUserIds(channel: string, configAllowFrom: unknown): string[] {
  const configEntries = normalizeAllowFromEntries(configAllowFrom).filter(
    (entry) => entry !== WILDCARD_ALLOW_ENTRY
  );
  const storeEntries = readChannelAllowFromStore(channel);
  return dedupeEntries([...configEntries, ...storeEntries]);
}

// 閺夆晜鏌ㄥú鏍純閺嶎厼甯抽柤濂変簻婵晠骞嶉悷鏉挎珯缂佹劖顨呰ぐ娑㈠棘閸ワ附顐介悹渚灠缁剁偤鏁嶉崸鐧穌ecar闁挎稑濂旂粭澶娦ч埄鍐帬 openclaw.json schema闁挎稑顦埀?
function resolveFeishuFirstPairingWindowPath(): string {
  return path.join(resolveUserStateDir(), "credentials", FEISHU_FIRST_PAIRING_WINDOW_FILE);
}

// 閻犲洩顕цぐ鍥純閺嶎厼甯抽柤濂変簻婵晠骞嶉悷鏉挎珯缂佹劖顨呰ぐ娑㈡偐閼哥鍋撴笟濠勫耿閻熸瑱绲鹃悗鑺ュ緞鏉堫偉袝閺夆晜鏌ㄥú?null闁挎稑濂旂换姘辨嫚娴ｇ晫娈堕柣顫妿椤忣剟鏌呴弰蹇曞竼缂佺姭鍋撻柛妤佹磸閳?
function readFeishuFirstPairingWindowState(): FeishuFirstPairingWindowState | null {
  const filePath = resolveFeishuFirstPairingWindowPath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = parseJsonSafe(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const openedAtMs = Number((parsed as Record<string, unknown>).openedAtMs);
    const expiresAtMs = Number((parsed as Record<string, unknown>).expiresAtMs);
    const consumedAtRaw = (parsed as Record<string, unknown>).consumedAtMs;
    const consumedAtMs = consumedAtRaw == null ? null : Number(consumedAtRaw);
    const consumedBy = String((parsed as Record<string, unknown>).consumedBy ?? "").trim();
    if (!Number.isFinite(openedAtMs) || !Number.isFinite(expiresAtMs)) {
      return null;
    }
    return {
      openedAtMs,
      expiresAtMs,
      consumedAtMs: consumedAtMs == null || !Number.isFinite(consumedAtMs) ? null : consumedAtMs,
      consumedBy,
    };
  } catch {
    return null;
  }
}

// 闁告鍠庨悺娆撳礃濞嗗繐寮冲Λ锝嗙墵閸樸倗绮ｅΔ鈧ぐ娑㈡偐閼哥鍋撴担瑙勭€ù鐘侯啇缁辨繈骞嶉埀顒勫嫉婢跺瞼宕堕柛娆欑悼濞村宕楀畷鍥﹂柟顑跨瑜板寮撮幘顔煎幋闂侇偅淇虹换鍐╂交濞嗗酣鍤嬮柛鎴ｅГ閺嗙喖鎷冮悾灞剧８闁?
function writeFeishuFirstPairingWindowState(state: FeishuFirstPairingWindowState): void {
  const filePath = resolveFeishuFirstPairingWindowPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

// 鐎殿喒鍋撻柛姘煎灦椤╁鏌婂鍫濇闁告柣鍔嶆竟鎺楀礄閸℃ɑ顦ч梻鍌氼嚟閻涖儵鏁嶅☉婊冾仧鐎圭寮剁粔椋庢嫻绾懐绠栭柛鎺撶懁缁绘岸骞愭担鍝勬櫖闁哄偆鍙忕槐婵囩▔瀹ュ懎鏅欓梺鎻掔Т缁辨垹绮ｅΔ鈧ぐ娑㈠Υ?
function openFeishuFirstPairingWindow(nowMs = Date.now()): void {
  const prev = readFeishuFirstPairingWindowState();
  if (prev?.consumedAtMs) {
    return;
  }
  writeFeishuFirstPairingWindowState({
    openedAtMs: nowMs,
    expiresAtMs: nowMs + FEISHU_FIRST_PAIRING_WINDOW_TTL_MS,
    consumedAtMs: null,
    consumedBy: "",
  });
}

// 闁稿繑濞婂Λ瀛橈純閺嶎厼甯抽柤濂変簻婵晠骞嶉悷鏉挎珯缂佹劖顨呰ぐ娑㈡晬濮橆厽寮撴繛鎴濈墣閸ㄥ倿宕烽悜妯荤彲闁告帞濞€濞呭酣寮崶锔筋偨闁挎稒绋戦崙鈥斥槈閸絽鐎柛锔惧劋濞呮瑦绌卞┑鍫熸畬闁绘梹姊归弻鍥冀閸ヮ亶鍞堕柕?
export function closeFeishuFirstPairingWindow(): void {
  const filePath = resolveFeishuFirstPairingWindowPath();
  const prev = readFeishuFirstPairingWindowState();
  if (prev?.consumedAtMs) {
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// 闁哄秴娲╅鍥純閺嶎厼甯崇紒鎰殔瑜版稑顔忛崣澶屝ラ悹鎰缁辨繈寮悩渚晥闁圭數鎳撻崳顖炲箣閹邦剙顫犻柟瀛樼墪閵囨垹鎷归妷鈺佸幋闁绘梹姊归弻鍥晬瀹€鍕級闁稿繐绉归崳鍝ユ嫚閺囥埄妫戦柡鍡樼暘閳?
export function consumeFeishuFirstPairingWindow(userId: string): void {
  const nowMs = Date.now();
  const prev = readFeishuFirstPairingWindowState();
  if (prev) {
    writeFeishuFirstPairingWindowState({
      ...prev,
      consumedAtMs: prev.consumedAtMs ?? nowMs,
      consumedBy: prev.consumedBy || String(userId ?? "").trim(),
    });
    return;
  }
  writeFeishuFirstPairingWindowState({
    openedAtMs: nowMs,
    expiresAtMs: nowMs,
    consumedAtMs: nowMs,
    consumedBy: String(userId ?? "").trim(),
  });
}

// 闁告帇鍊栭弻鍥純閺嶎厼甯崇紒鎰殔瑜版盯寮伴姘剨濠㈣泛瀚花顒勬偨閻斿憡娅忛柡鍫㈠櫐缁辫鲸娼婚崶銊﹀焸闁瑰瓨鐗曢崙鈥斥槈閸絽鐎梺顔尖偓鐔虹闁?false闁挎稑鑻懟鐔兼嚊椤忓嫬袟婵炴挸鎳愰幃濠冩交閸ャ劍鍩傜紒鎰殔瑜版盯濡?
export function isFeishuFirstPairingWindowActive(nowMs = Date.now()): boolean {
  const state = readFeishuFirstPairingWindowState();
  if (!state) {
    return false;
  }
  if (state.consumedAtMs) {
    return false;
  }
  if (nowMs > state.expiresAtMs) {
    closeFeishuFirstPairingWindow();
    return false;
  }
  return nowMs >= state.openedAtMs;
}

// 闁哄秷顫夊畵浣姐亹閹惧啿顤呭瀣仒閸旂喖鏌婂鍥╂瀭濞戞挸瀛╁鍧楀级閸愵亜笑闁诡兛鑳跺ǎ顕€骞庨妶澶樻禃闂佹澘绉堕悰銉╁矗閿濆繒绀夐梺顒€鐏濋崢銈夊箮婵犲嫮宕堕柛娆欑悼婵悂骞€娴ｈ娈犻柦鈧挊澶嬭含濠㈣埖鐭柌婊呮嫬閸愵亝鏆忛柣鎰畭閳?
function reconcileFeishuFirstPairingWindow(config: any): void {
  const enabled = config?.plugins?.entries?.feishu?.enabled === true;
  if (!enabled) {
    closeFeishuFirstPairingWindow();
    return;
  }

  const feishu = config?.channels?.feishu ?? {};
  const dmPolicy = normalizeDmPolicy(feishu?.dmPolicy, "pairing");
  if (dmPolicy !== "pairing") {
    closeFeishuFirstPairingWindow();
    return;
  }

  const approvedUserIds = collectApprovedUserIds(FEISHU_CHANNEL, feishu?.allowFrom);
  if (approvedUserIds.length > 0) {
    closeFeishuFirstPairingWindow();
    return;
  }

  openFeishuFirstPairingWindow();
}

// 缂備胶鍠嶇粩瀛樻交閹邦垼鏀?openclaw CLI 閻庢稒鍔曢幊鈩冪閵堝繒绀夊璺虹Ф閺?OneClaw 闁告劕鎳庣粊?runtime 濞戞挸娴风紞澶愬礂閸愭彃寮抽柛娆欑祷閳?
async function runGatewayCli(args: string[]): Promise<CliRunResult> {
  const nodeBin = resolveNodeBin();
  const entry = resolveGatewayEntry();
  const cwd = resolveGatewayCwd();
  const runtimeDir = path.join(resolveResourcesPath(), "runtime");
  const envPath = runtimeDir + path.delimiter + (process.env.PATH ?? "");

  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [entry, ...args], {
      cwd,
      env: {
        ...process.env,
        ...resolveNodeExtraEnv(),
        // 缂備胶鍠嶇粩鎾礂閹惰姤锛旈柛蹇嬪劚瑜版稒绂嶇仦缁㈠仹 respawn闁挎稑濂旂换姘辨嫚娴ｇ懓顣查柡鍫濐槺閻擃參宕?CLI 閻庢稒鍔曢幊鈩冪閵堝鍘撮梻鍫熺懇缁垱娼婚幇顖ｆ斀
        OPENCLAW_NO_RESPAWN: "1",
        PATH: envPath,
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: typeof code === "number" ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

// 閻庣懓顦崣蹇曟喆閿濆棛鈧?JSON闁挎稑鑻妵鎴犳嫻閵夛附顦ч弶鈺傛煥濞?null闁挎稑鐭傛导鈺呭礂瀹ュ洦娅曢梻鍫涘灩濞叉粓寮介悡搴ｇ婵炲鍨规慨鈺佺暦閳哄倻鐨鹃柕?
function parseJsonSafe(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // CLI 闁告瑯鍨甸崗姗€宕?JSON 闁告挸绉垫晶锕傚础閻楀牆绲诲ù鐘哄煐濡晞绠涘Δ瀣閺夆晜鐟╅崳鐑藉炊閻愯　鍋撻埀顒勫礆閹垫枼鍋撳鍕倒闁告瑦鐗楀﹢顖滀焊?JSON 閻庣數顢婇挅鍕灳濠靛牏鎽滈柣锝冨劘閳?
    const match = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// 闁告ê顑囩紓?CLI 闂佹寧鐟ㄩ銈嗙┍閳╁啩绱栭柨娑樺缁鳖參宕楅崼婊呯闁伙絾鐟﹀﹢渚€鎮介妸銊х炕闁告垵鎼懟鐔兼⒔閸曨偆鏁ㄩ柛蹇旂矊缁ㄦ娊骞撹箛姘墯闁?
function compactCliError(run: CliRunResult, fallback: string): string {
  const out = run.stderr.trim() || run.stdout.trim();
  if (!out) return fallback;
  const firstLine = out.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine ? firstLine.trim() : fallback;
}

// 閻熸瑥瀚€垫牠宕?allowFrom 闁告帗顨夐妴鍐晬瀹€鈧划鐑樼▔閳ь剚娼浣稿簥濞戞挻妞藉顏嗙矚閸濆嫮鎽熺紒妤嬬細鐟曞棝鐛捄鍝勭闂佹彃绉查埀?
function normalizeAllowFromEntries(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return dedupeEntries(
    input
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0)
  );
}

// 闁轰焦澹嗙划宥夊储婵犳艾娅㈡鐐存构缁绘岸骞愭担绋挎枾濠殿喖顑夐妴搴㈡償韫囧鍋?
function dedupeEntries(items: string[]): string[] {
  return [...new Set(items)];
}

// 缂備胶鍠嶇粩瀵告喆閿濆棛鈧?pairing allowFrom store 闁哄倸娲ｅ▎銏ゆ晬閸垺鏆?openclaw pairing approve 闁告劖鐟ラ崣鍡涙晬婢跺牃鍋?
function readChannelAllowFromStore(channel: string): string[] {
  return readChannelAllowFromStoreEntriesFromFs(
    path.join(resolveUserStateDir(), "credentials"),
    channel,
  );
}

// 闁告劖鐟ラ崣?pairing allowFrom store 闁哄倸娲ｅ▎銏ゆ晬閸繂鎮戦悗褰掆偓娑氱闁伙絾鐟ョ敮顐﹀嫉婢跺﹦鎽熸繛鍫㈩暜缁辨岸濡?
function writeChannelAllowFromStore(channel: string, entries: string[]): void {
  writeChannelAllowFromStoreEntriesFromFs(
    path.join(resolveUserStateDir(), "credentials"),
    channel,
    entries,
  );
}

// 閻犲洩顕цぐ鍥嫉椤掆偓濠€鎾灳濠婂啫鍤掗柟閿嬪笧缁兘鏌婂鍜佸殸闁活喕璁查埀顒佸珘idecar闁挎稑鐬奸弫銈嗙鎼淬倗绠栨繝濞垮€曠欢鐔衡偓鍏夊墲婢规帡宕氬Δ鍕┾偓鍐Υ?
function readRejectedPairingStore(fileName: string): FeishuRejectedPairingStore {
  const filePath = path.join(resolveUserStateDir(), "credentials", fileName);
  if (!fs.existsSync(filePath)) {
    return { version: 1, codes: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = parseJsonSafe(raw);
    const codes = normalizeAllowFromEntries(parsed?.codes);
    return { version: 1, codes };
  } catch {
    return { version: 1, codes: [] };
  }
}

// 闁告劖鐟ラ崣鍡涘嫉椤掆偓濠€鎾灳濠婂啫鍤掗柟閿嬪笧缁兘鏌婂鍜佸殸闁活喕璁查埀顒佸珘idecar闁挎稑鐬奸埞鏍极閹殿喚鐭嬮柡鍐硾閸ㄥ綊姊介妶鍡樼€ù鐘虹堪閳?
function writeRejectedPairingStore(fileName: string, codes: string[]): void {
  const normalized = normalizeAllowFromEntries(codes);
  const dir = path.join(resolveUserStateDir(), "credentials");
  const filePath = path.join(dir, fileName);
  if (normalized.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const payload: FeishuRejectedPairingStore = {
    version: 1,
    codes: normalized,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

// 閻犲洩顕цぐ鍥蓟閹邦亪鍤嬫繛鎾跺█娴滈箖鎯冮崟顒€鐝曠紓浣圭箘閻栨粓宕氬Δ鍕┾偓鍐Υ?
function readRejectedPairingCodes(fileName: string): string[] {
  return readRejectedPairingStore(fileName).codes;
}

// 閺夆晞妫勬慨鐐哄础閺囨岸鍤嬮柟閿嬪笧缁兘鎯嶆笟濠勭妤犵偛鍊婚悺鎴︽晬婢跺牃鍋?
function appendRejectedPairingCode(fileName: string, code: string): void {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return;
  const store = readRejectedPairingStore(fileName);
  if (store.codes.includes(trimmed)) return;
  store.codes.push(trimmed);
  writeRejectedPairingStore(fileName, store.codes);
}

// 缂佸顭峰▍搴ㄥ础閺囨岸鍤嬮柟閿嬪笧缁兘鎯嶆笟濠勭闁圭數鎳撻崳顖炲触鎼淬倕娈伴柛鏂诲妽缁斿鎮堕崱顓犵闁?
function removeRejectedPairingCode(fileName: string, code: string): void {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return;
  const store = readRejectedPairingStore(fileName);
  const nextCodes = store.codes.filter((item) => item !== trimmed);
  if (nextCodes.length === store.codes.length) return;
  writeRejectedPairingStore(fileName, nextCodes);
}

// 婵炴挸鎳愰幃濠冩交閸ャ劍鍩傞柟閿嬪笧缁兘鎯嶆笟濠勭獥闁告瑯浜欑换姘舵偩濞嗗繒绉奸柛?pending 闁告帗顨夐妴鍐煂鐏炶偐鐭濋悗娑櫭﹢顏堟儍?code闁?
function pruneRejectedPairingCodes(fileName: string, activeCodes: Set<string>): void {
  const store = readRejectedPairingStore(fileName);
  if (store.codes.length === 0) return;
  const nextCodes = store.codes.filter((code) => activeCodes.has(code));
  if (nextCodes.length === store.codes.length) return;
  writeRejectedPairingStore(fileName, nextCodes);
}

// 婵炴挾濞€娴滅偓绋夐幘鑸垫殢 sidecar 闁哄倸娲ｅ▎銏ゅ及閻樿尙娈搁柨娑欑〒濞蹭即宕滃鍛锭闁哄牆顦甸ˉ锝嗙▕閿曗偓閹风増瀵兼担椋庣懝鐎甸偊鍠曟穱濠冨濮樺疇娉查弶鈺傜懃椤ㄦ粓骞忛幒鏃傚崪闁活喕绶氶埀顒佹缁额偊濡?
function resolveRejectedPairingStoreFile(channel: string): string {
  if (channel === WECOM_CHANNEL_ID) {
    return WECOM_REJECTED_PAIRING_STORE_FILE;
  }
  return FEISHU_REJECTED_PAIRING_STORE_FILE;
}

// 閻犲洩顕цぐ鍥槹閻愭澘濮?allowFrom store 闁哄倸娲ｅ▎銏ゆ晬閸垺鏆?openclaw pairing approve 闁告劖鐟ラ崣鍡涙晬婢跺牃鍋?
function readFeishuAllowFromStore(): string[] {
  return readChannelAllowFromStore(FEISHU_CHANNEL);
}

// 闁告劖鐟ラ崣鍡橆槹閻愭澘濮?allowFrom store 闁哄倸娲ｅ▎銏ゆ晬閸繂鎮戦悗褰掆偓娑氱闁伙絾鐟ョ敮顐﹀嫉婢跺﹦鎽熸繛鍫㈩暜缁辨岸濡?
function writeFeishuAllowFromStore(entries: string[]): void {
  writeChannelAllowFromStore(FEISHU_CHANNEL, entries);
}

// 閻犲洩顕цぐ鍥箯閹烘梻鍗滈柣顔荤閸亞鎮伴妸锝傚亾?
function readFeishuRejectedPairingCodes(): string[] {
  return readRejectedPairingCodes(FEISHU_REJECTED_PAIRING_STORE_FILE);
}

// 閺夆晞妫勬慨鐐哄础閺囨岸鍤嬮柟閿嬪笧缁兘鎯嶆笟濠勭妤犵偛鍊婚悺鎴︽晬婢跺牃鍋?
function appendFeishuRejectedPairingCode(code: string): void {
  appendRejectedPairingCode(FEISHU_REJECTED_PAIRING_STORE_FILE, code);
}

// 缂佸顭峰▍搴ㄥ础閺囨岸鍤嬮柟閿嬪笧缁兘鎯嶆笟濠勭闁圭數鎳撻崳顖炲触鎼淬倕娈伴柛鏂诲妽缁斿鎮堕崱顓犵闁?
function removeFeishuRejectedPairingCode(code: string): void {
  removeRejectedPairingCode(FEISHU_REJECTED_PAIRING_STORE_FILE, code);
}

// 婵炴挸鎳愰幃濠冩交閸ャ劍鍩傞柟閿嬪笧缁兘鎯嶆笟濠勭獥闁告瑯浜欑换姘舵偩濞嗗繒绉奸柛?pending 闁告帗顨夐妴鍐煂鐏炶偐鐭濋悗娑櫭﹢顏堟儍?code闁?
function pruneFeishuRejectedPairingCodes(activeCodes: Set<string>): void {
  pruneRejectedPairingCodes(FEISHU_REJECTED_PAIRING_STORE_FILE, activeCodes);
}

// 閻炴稏鍎遍崣蹇涘箳閸喐缍€闁哄绱曞ú浼存儍閸曨偄璁查悹鍥嚙閹洜绮旂敮顔剧獥闁活潿鍔嶉崺?缂傚洢鍊涙禍鐗堝濡搫甯ラ柡灞诲劤缁憋妇鈧稒锕槐婵嬪嫉椤忓嫭鍤掑☉鎿冨幖閸垳鈧湱鍋炲鍌炲蓟閵夘煈鍤勬鐐舵硾濞叉牠宕樺▎鎴犲閻庢稒菧閳?
async function enrichFeishuEntryNames(
  entries: FeishuAuthorizedEntryView[],
  feishuConfig: Record<string, unknown>,
): Promise<FeishuAuthorizedEntryView[]> {
  const appId = String(feishuConfig?.appId ?? "").trim();
  const appSecret = String(feishuConfig?.appSecret ?? "").trim();
  if (!appId || !appSecret || entries.length === 0) {
    return entries;
  }

  const userTargets = entries.filter(
    (entry) => entry.kind === "user" && !entry.name && looksLikeFeishuUserId(entry.id)
  );
  const groupTargets = entries.filter(
    (entry) => entry.kind === "group" && !entry.name && looksLikeFeishuGroupId(entry.id)
  );
  if (userTargets.length === 0 && groupTargets.length === 0) {
    return entries;
  }

  const token = await resolveFeishuTenantAccessToken(appId, appSecret);
  if (!token) {
    return entries;
  }

  await Promise.all(
    userTargets.map(async (entry) => {
      const name = await fetchFeishuUserNameByOpenId(token, entry.id);
      if (name) {
        entry.name = name;
        saveFeishuAlias("user", entry.id, name);
      }
    })
  );

  await Promise.all(
    groupTargets.map(async (entry) => {
      const name = await fetchFeishuChatNameById(token, entry.id);
      if (name) {
        entry.name = name;
        saveFeishuAlias("group", entry.id, name);
      }
    })
  );

  return entries;
}

// 闁兼儳鍢茶ぐ?tenant_access_token闁挎稑鐗嗛崬瀵糕偓娑欘焽缁憋妇鈧稒锕槐婵囨交閸ャ劍鍩傞柛鎾崇С缁旀挳宕氶崱娑欏闁煎浜滄慨鈺呭礆闁垮鐓€闁挎稑顦埀?
async function resolveFeishuTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const now = Date.now();
  if (
    feishuTenantTokenCache &&
    feishuTenantTokenCache.appId === appId &&
    feishuTenantTokenCache.appSecret === appSecret &&
    feishuTenantTokenCache.expireAt > now + FEISHU_TOKEN_SAFETY_MS
  ) {
    return feishuTenantTokenCache.token;
  }

  const payload = await fetchJsonWithTimeout(`${FEISHU_OPEN_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const code = Number(payload?.code ?? -1);
  const token = String(payload?.tenant_access_token ?? "").trim();
  const expire = Number(payload?.expire ?? 0);
  if (code !== 0 || !token || !Number.isFinite(expire) || expire <= 0) {
    return "";
  }

  feishuTenantTokenCache = {
    appId,
    appSecret,
    token,
    expireAt: now + expire * 1000,
  };
  return token;
}

// 闁哄秷顫夊畵?open_id 闁哄被鍎撮妤呮偨閵婏箑鐓曢柛姘Р閳?
async function fetchFeishuUserNameByOpenId(token: string, openId: string): Promise<string> {
  const encodedId = encodeURIComponent(openId);
  const url = `${FEISHU_OPEN_API_BASE}/contact/v3/users/${encodedId}?user_id_type=open_id`;
  const payload = await fetchJsonWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  if (Number(payload?.code ?? -1) !== 0) return "";
  return String(payload?.data?.user?.name ?? payload?.data?.name ?? "").trim();
}

// 闁哄秷顫夊畵?chat_id 闁哄被鍎撮妤冪礃閵堝懏鍊崇紒澶庡焽閳?
async function fetchFeishuChatNameById(token: string, chatId: string): Promise<string> {
  const encodedId = encodeURIComponent(chatId);
  const url = `${FEISHU_OPEN_API_BASE}/im/v1/chats/${encodedId}`;
  const payload = await fetchJsonWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  if (Number(payload?.code ?? -1) !== 0) return "";
  return String(payload?.data?.chat?.name ?? payload?.data?.name ?? "").trim();
}

// 閻㈩垽绠掔粔鎾籍閸撲焦鐣?JSON 閻犲洭鏀遍惇浼存晬濞戞ǜ浜奸悹鎰╁劥缁绘垿宕?null闁挎稑濂旂粭澶愭⒓鐠囧樊鏁氬☉鎾剁帛缁侊妇绮欑€ｃ劉鍋?
async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    return parseJsonSafe(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 鐟滅増甯婄粩鎾礌?DM 缂佹稒鐗滈弳鎰版晬瀹€鍕婵炲娲栭埀顒傚帶濞叉牠鏌呴埀顒佺▔濞差亞甯涢悹浣靛€曢埀顒傤儠閳?
function normalizeDmPolicy(input: unknown, fallback: "open" | "pairing" | "allowlist"): "open" | "pairing" | "allowlist" {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "open" || value === "pairing" || value === "allowlist") {
    return value;
  }
  return fallback;
}

// 鐟滅増甯婄粩鎾礌閺嶎偄鍙冮柤鍗烇功閻°儵鎮鹃妷顖滅闂傚牏鍋炵涵鍫曞磹閻撳孩绀€闂侇偀鍋撳☉鎾存そ缁垳鎷嬮妶鍛亾缁楄　鍋?
function normalizeGroupPolicy(input: unknown, fallback: "open" | "allowlist" | "disabled"): "open" | "allowlist" | "disabled" {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "open" || value === "allowlist" || value === "disabled") {
    return value;
  }
  return fallback;
}

// 鐟滅増甯婄粩鎾礌閺嶎剛妯堝Λ鐗埫肩槐鎵嫚濠靛牏鎽滈柣锝冨劵缁辨繈妫冮悙瀵搞€婇柛濠勫帶濞叉牠鏌呴埀顒佺▔濞差亞甯涢悹浣靛€曢埀顒傤儠閳?
function normalizeTopicSessionMode(input: unknown, fallback: "enabled" | "disabled"): "enabled" | "disabled" {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "enabled" || value === "disabled") {
    return value;
  }
  return fallback;
}

// 鐟滅増甯婄粩鎾礌閺嶎偒娼岄柤鍗烇梗缁辨壆鎷犲┑濠傜槺闁搞儴鎻槐婵嬫閻愬銆婇柛濠勫帶濞叉牠鏌呴埀顒佺▔濞差亞甯涢悹浣靛€曢埀顒傤儠閳?
function normalizeDmScope(
  input: unknown,
  fallback: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer"
): "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer" {
  const value = String(input ?? "").trim().toLowerCase();
  if (
    value === "main" ||
    value === "per-peer" ||
    value === "per-channel-peer" ||
    value === "per-account-channel-peer"
  ) {
    return value;
  }
  return fallback;
}

// 闁告帇鍊栭弻鍥┾偓娑欘殘椤戜焦绋夐崣澶嬓﹂柛姘剧畱閸庢碍顦伴悙鏉垮闁活潿鍔嶉崺?open_id闁?
function looksLikeFeishuUserId(value: string): boolean {
  return /^ou_[A-Za-z0-9]/.test(value);
}

// 闁告帇鍊栭弻鍥┾偓娑欘殘椤戜焦绋夐崣澶嬓﹂柛姘剧畱閸庢碍顦伴悙鏉垮缂傚洢鍊涙禍?chat_id闁?
function looksLikeFeishuGroupId(value: string): boolean {
  return /^oc_[A-Za-z0-9]/.test(value);
}

// 閻忓繐妫欏鍧楀级閸愨晜钂嬮柣鈺婂枦濞村棝骞戦～顓＄闁告挸绉堕顒備沪閺囩姰浠涙俊顖椻偓宕団偓鐑芥晬鐏炶偐鍠橀柛蹇撶墣缁绘垿宕堕悙鎻掕閻犲洩顕ч幃鏇犵矓閼割兘鍋?
function toAuthorizedEntryView(kind: "user" | "group", id: string, aliases: FeishuAliasStore): FeishuAuthorizedEntryView {
  const trimmedId = String(id ?? "").trim();
  const aliasName = kind === "user" ? aliases.users[trimmedId] : aliases.groups[trimmedId];
  if (aliasName) {
    return { kind, id: trimmedId, name: aliasName };
  }

  if (kind === "user" && !looksLikeFeishuUserId(trimmedId)) {
    return { kind, id: trimmedId, name: trimmedId };
  }
  if (kind === "group" && !looksLikeFeishuGroupId(trimmedId)) {
    return { kind, id: trimmedId, name: trimmedId };
  }
  return { kind, id: trimmedId, name: "" };
}

// 闁瑰搫鐗婂鍫ュ级閿涘嫭绐楅柟鐑樺笒缁參鏁嶅顐ゅ枠闁稿繐鐗婄€垫粓宕ｉ婵愬殺闁告艾绉惰ⅷ闁挎稑鑻崯鈧柟绋款槸鐢偅鎱?ID闁?
function compareAuthorizedEntry(a: FeishuAuthorizedEntryView, b: FeishuAuthorizedEntryView): number {
  const aLabel = (a.name || a.id).toLowerCase();
  const bLabel = (b.name || b.id).toLowerCase();
  const byLabel = aLabel.localeCompare(bLabel, "en");
  if (byLabel !== 0) return byLabel;
  return a.id.localeCompare(b.id, "en");
}

// 閻犲洩顕цぐ鍥槹閻愭澘濮涢柟鍝勭墛濞煎牓宕氶銏″€抽柨娑樼墢閺併倖绂嶆惔銏犖?ID 闁哄嫬澧介妵姘跺箣閹邦喗鏆忛柟?缂傚洢鍊涙禍浼村触瀹ュ泦鐐烘晬婢跺牃鍋?
function readFeishuAliasStore(): FeishuAliasStore {
  const filePath = path.join(resolveUserStateDir(), "credentials", FEISHU_ALIAS_STORE_FILE);
  if (!fs.existsSync(filePath)) {
    return { version: 1, users: {}, groups: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = parseJsonSafe(raw);
    const users = parsed && typeof parsed.users === "object" && !Array.isArray(parsed.users)
      ? Object.fromEntries(
          Object.entries(parsed.users).map(([id, name]) => [String(id).trim(), String(name ?? "").trim()])
        )
      : {};
    const groups = parsed && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)
      ? Object.fromEntries(
          Object.entries(parsed.groups).map(([id, name]) => [String(id).trim(), String(name ?? "").trim()])
        )
      : {};
    return {
      version: 1,
      users: Object.fromEntries(Object.entries(users).filter(([id, name]) => id && name)),
      groups: Object.fromEntries(Object.entries(groups).filter(([id, name]) => id && name)),
    };
  } catch {
    return { version: 1, users: {}, groups: {} };
  }
}

// 闁告劖鐟ラ崣鍡橆槹閻愭澘濮涢柟鍝勭墛濞煎牓宕氶銏″€抽悗娑櫭崑宥夊Υ?
function writeFeishuAliasStore(store: FeishuAliasStore): void {
  const dir = path.join(resolveUserStateDir(), "credentials");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, FEISHU_ALIAS_STORE_FILE);
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

// 濞ｅ洦绻傞悺銊╁础閺囩喐钂嬪瀣仒閸旂喖骞掗崼鐔哥秬闁告帩鍋勯幃鏇㈡晬鐏炶偐杩旈柛鎺擃殙閵嗗啰浠﹂弴鐘粵濞村吋锚閸樻稒鎷呯捄銊︽殢闁告艾绉惰ⅷ闁?
function saveFeishuAlias(kind: "user" | "group", id: string, name: string): void {
  const trimmedId = String(id ?? "").trim();
  const trimmedName = String(name ?? "").trim();
  if (!trimmedId || !trimmedName) return;
  const store = readFeishuAliasStore();
  if (kind === "user") {
    store.users[trimmedId] = trimmedName;
  } else {
    store.groups[trimmedId] = trimmedName;
  }
  writeFeishuAliasStore(store);
}

// 闁告帞濞€濞呭酣宕￠弴鐔歌拫濡炲鍋橀崝鐔煎箳閸喐缍€闁告帩鍋勯幃鏇㈠Υ?
function removeFeishuAlias(kind: "user" | "group", id: string): void {
  const trimmedId = String(id ?? "").trim();
  if (!trimmedId) return;
  const store = readFeishuAliasStore();
  if (kind === "user") {
    delete store.users[trimmedId];
  } else {
    delete store.groups[trimmedId];
  }
  writeFeishuAliasStore(store);
}

// 闁冲厜鍋撻柍鍏夊亾 濞寸姴閰ｉ崢銈囩磾椤旀槒鍘柟缁樺姇瑜板洩銇愰幘鍐差枀 provider 濞ｅ洠鍓濇导鍛存晬閸у嵅iKey 闁硅　鏅濋悥婊堟晬?闁冲厜鍋撻柍鍏夊亾



// 闁告艾鐗嗛懟鐔肺熼垾宕団偓鐑藉礆濡ゅ嫨鈧啴鏁嶅顐ょ闁伙絾鐟ュ濠氬矗閸欏渚€宕圭€ｅ墎绀夐柛姘湰濡炲倿鎮介妸锔戒粯闁哄倷鍗抽崢銈囩磾椤旀娲柣鈺傜墪缂嶅宕滃澶嗗亾婢跺鍘俊顖椻偓宕団偓鐑芥晬閸繍娲?input 闁煎疇妫勬慨蹇涘矗濡粯绾柨娑橆槶閳?
function mergeModels(provEntry: any, selectedID: string, prevModels: any[]): void {
  if (!provEntry || !prevModels.length) return;
  const newEntry = (provEntry.models ?? [])[0]; // buildProviderConfig 闁汇垻鍠愰崹姘舵儍閸曨偄绀嬮柡澶涚磿濞?
  const merged = [...prevModels];
  const currentIndex = merged.findIndex((m: any) => m?.id === selectedID);
  if (currentIndex >= 0) {
    if (newEntry) {
      merged[currentIndex] = {
        ...(merged[currentIndex] && typeof merged[currentIndex] === "object"
          ? merged[currentIndex]
          : {}),
        ...newEntry,
      };
    }
  } else if (newEntry) {
    merged.push(newEntry);
  }
  provEntry.models = merged;
}

// API Key 闁硅　鏅濋悥婊堟晬濮橆偆绠介柣锝嗙懇椤╄崵浜搁幆褎鍊?4 閻庢稒顨堥?
function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return key ? "********" : "";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
