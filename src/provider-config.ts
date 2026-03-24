import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import { resolveUserConfigPath, resolveUserStateDir } from "./constants";
import { backupCurrentUserConfig } from "./config-backup";
import { parseJsonText } from "./json-utils";
import { migrateEmbeddedModelRoutesToSidecar } from "./model-routes";

// 鈹€鈹€ Provider 閰嶇疆棰勮锛堜笌 kimiclaw ProviderSetupView.swift 瀵归綈?鈹€鈹€

export interface ProviderPreset {
  baseUrl: string;
  api: string;
}

export interface SubPlatformPreset extends ProviderPreset {
  providerKey: string;
}

const WBSMODELS_BASE_URL = "https://onekey.dualseason.com/v1";
const CLAWIMAGE_BASE_URL = "https://claw.dualseason.com/v1";
const CLAWIMAGE_DEFAULT_MODEL_ID = "gemini-3.0-pro-image-2k";

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  wbsmodels: { baseUrl: WBSMODELS_BASE_URL, api: "openai-responses" },
  clawimage: { baseUrl: CLAWIMAGE_BASE_URL, api: "openai-completions" },
};

// Moonshot sub-platform presets.
export const MOONSHOT_SUB_PLATFORMS: Record<string, SubPlatformPreset> = {
  "moonshot-cn": { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", providerKey: "moonshot" },
  "moonshot-ai": { baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", providerKey: "moonshot" },
  "kimi-code": { baseUrl: "https://api.kimi.com/coding", api: "anthropic-messages", providerKey: "kimi-coding" },
};

export const GLM_SUB_PLATFORMS: Record<string, SubPlatformPreset> = {
  "glm-standard": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", providerKey: "zai" },
  "glm-coding": { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions", providerKey: "zai" },
};

export const MINIMAX_SUB_PLATFORMS: Record<string, SubPlatformPreset> = {
  "minimax-global": { baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages", providerKey: "minimax" },
  "minimax-cn": { baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages", providerKey: "minimax-cn" },
};

export const BUILTIN_SUB_PLATFORM_PROVIDERS: Record<string, Record<string, SubPlatformPreset>> = {
  moonshot: MOONSHOT_SUB_PLATFORMS,
  glm: GLM_SUB_PLATFORMS,
  minimax: MINIMAX_SUB_PLATFORMS,
};

const BUILTIN_SUB_PLATFORM_DEFAULTS: Record<string, string> = {
  moonshot: "moonshot-cn",
  glm: "glm-standard",
  minimax: "minimax-global",
};

// Built-in presets for the Custom tab (quick presets for domestic providers).
export interface CustomProviderPreset extends ProviderPreset {
  providerKey: string;
  placeholder: string;
  models: string[];
  keyOptional?: boolean;
}

export const CUSTOM_PROVIDER_PRESETS: Record<string, CustomProviderPreset> = {
  "minimax": {
    providerKey: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    placeholder: "eyJ...",
    models: ["MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
  },
  "minimax-cn": {
    providerKey: "minimax-cn",
    baseUrl: "https://api.minimaxi.com/anthropic",
    api: "anthropic-messages",
    placeholder: "eyJ...",
    models: ["MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
  },
  "zai-global": {
    providerKey: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    api: "openai-completions",
    placeholder: "...",
    models: ["glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],
  },
  "zai-cn": {
    providerKey: "zai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    placeholder: "...",
    models: ["glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],
  },
  "zai-cn-coding": {
    providerKey: "zai",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-completions",
    placeholder: "...",
    models: ["glm-5", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],
  },
  "volcengine": {
    providerKey: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    placeholder: "...",
    models: ["doubao-seed-2.0-pro", "doubao-seed-2.0-lite", "doubao-seed-2.0-code", "doubao-seed-code"],
  },
  "volcengine-coding": {
    providerKey: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    api: "openai-completions",
    placeholder: "...",
    models: ["doubao-seed-2.0-code", "doubao-seed-2.0-pro", "doubao-seed-2.0-lite", "doubao-seed-code", "minimax-m2.5", "glm-4.7", "deepseek-v3.2", "kimi-k2.5", "ark-code-latest"],
  },
  "qwen": {
    providerKey: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    placeholder: "sk-...",
    models: ["qwen-coder-plus-latest", "qwen-plus-latest", "qwen-max-latest", "qwen-turbo-latest"],
  },
  "qwen-coding": {
    providerKey: "qwen",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    api: "openai-completions",
    placeholder: "sk-sp-...",
    models: ["qwen3.5-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5",],
  },
  "deepseek": {
    providerKey: "deepseek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    placeholder: "sk-...",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  "ollama": {
    providerKey: "ollama",
    baseUrl: "http://localhost:11434",
    api: "openai-completions",
    placeholder: "",
    models: [],
    keyOptional: true,
  },
};

export function getBuiltinSubPlatform(provider: string, subPlatform?: string): SubPlatformPreset | undefined {
  const platforms = BUILTIN_SUB_PLATFORM_PROVIDERS[provider];
  if (!platforms) return undefined;
  const fallback = BUILTIN_SUB_PLATFORM_DEFAULTS[provider];
  return platforms[subPlatform || fallback] || platforms[fallback];
}

// 鈹€鈹€ 鏋勫缓 Provider 閰嶇疆瀵硅薄 鈹€鈹€

export function buildProviderConfig(
  provider: string,
  apiKey: string,
  modelID: string,
  baseURL?: string,
  api?: string,
  supportImage?: boolean,
  customPreset?: string
): Record<string, unknown> {
  const preset = PROVIDER_PRESETS[provider];
  if (provider === "clawimage") {
    return buildClawImageProviderConfig(
      apiKey,
      modelID,
      baseURL || PROVIDER_PRESETS.clawimage.baseUrl,
      api || PROVIDER_PRESETS.clawimage.api,
    );
  }

  // Built-in provider preset (for example wbsmodels): fixed base URL + API.
  if (preset) {
    return {
      apiKey,
      baseUrl: baseURL || preset.baseUrl,
      api: api || preset.api,
      models: [{ id: modelID, name: modelID, input: ["text", "image"] }],
    };
  }

  // Custom tab preset: keep preset API type and allow optional baseURL override.
  const customPre = customPreset ? CUSTOM_PROVIDER_PRESETS[customPreset] : undefined;
  if (customPre) {
    return {
      apiKey,
      baseUrl: baseURL || customPre.baseUrl,
      api: customPre.api,
      models: [{ id: modelID, name: modelID, input: ["text", "image"] }],
    };
  }

  // Manual custom mode.
  const input = supportImage !== false ? ["text", "image"] : ["text"];
  return {
    apiKey,
    baseUrl: baseURL,
    api: api || "openai-completions",
    models: [{ id: modelID, name: modelID, input }],
  };
}

// clawimage provider template.

export function buildClawImageProviderConfig(
  apiKey: string,
  modelID = CLAWIMAGE_DEFAULT_MODEL_ID,
  baseURL = CLAWIMAGE_BASE_URL,
  apiType = "openai-completions",
): Record<string, unknown> {
  const resolvedModelId = modelID || CLAWIMAGE_DEFAULT_MODEL_ID;
  return {
    baseUrl: baseURL || CLAWIMAGE_BASE_URL,
    apiKey,
    headers: { "Content-Type": "application/json" },
    auth: "token",
    authHeader: true,
    api: apiType || "openai-completions",
    models: [
      {
        id: resolvedModelId,
        name: resolvedModelId,
        api: apiType || "openai-completions",
        input: ["text", "image"],
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
}

// 鈹€鈹€ Moonshot 瀛愬钩鍙伴厤缃啓?鈹€鈹€
export function saveMoonshotConfig(
  config: any,
  apiKey: string,
  modelID: string,
  subPlatform: string
): void {
  saveSubPlatformConfig(config, "moonshot", apiKey, modelID, subPlatform);
}

export function saveSubPlatformConfig(
  config: any,
  provider: string,
  apiKey: string,
  modelID: string,
  subPlatform?: string
): void {
  const sub = getBuiltinSubPlatform(provider, subPlatform);
  if (!sub) {
    throw new Error(`Unknown built-in provider: ${provider}`);
  }
  const providerKey = sub.providerKey;

  // 鎵€鏈夊瓙骞冲彴缁熶竴鍐欐硶锛歛piKey + baseUrl + api + models 鍐欏叆 providers
  config.models.providers[providerKey] = {
    apiKey,
    baseUrl: sub.baseUrl,
    api: sub.api,
    models: [{ id: modelID, name: modelID, input: ["text", "image"] }],
  };

  config.agents.defaults.model.primary = `${providerKey}/${modelID}`;
}

// 鈹€鈹€ 鐢ㄦ埛閰嶇疆璇诲啓锛堣杽灏佽?鈹€鈹€

export function readUserConfig(): any {
  const configPath = resolveUserConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    return parseJsonText(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

export function writeUserConfig(config: any): void {
  const stateDir = resolveUserStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  // OpenClaw schema does not accept the top-level `oneclaw` key.
  // If legacy metadata exists there, migrate it to sidecar and strip the key before write.
  migrateEmbeddedModelRoutesToSidecar(config);
  // Snapshot current parseable config before overwrite so users can roll back from Settings.
  backupCurrentUserConfig();
  const configPath = resolveUserConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// 鈹€鈹€ 楠岃瘉鍑芥暟 鈹€鈹€

// 涓囧崥灞卞唴缃叆鍙ｆ寜 OpenAI 鍏煎鎺ュ彛楠岃瘉
export function verifyClawimage(apiKey: string, modelID?: string, baseURL?: string): Promise<void> {
  // Do not probe image-only models via /chat/completions text payload.
  // Validate clawimage by checking /models with the provided key.
  void modelID;
  return verifyOpenAIModels(apiKey, baseURL || PROVIDER_PRESETS.clawimage.baseUrl);
}

// Moonshot sub-platform verification (uses different endpoints by sub-platform).
export function verifyMoonshot(apiKey: string, subPlatform?: string, modelID?: string): Promise<void> {
  const sub = MOONSHOT_SUB_PLATFORMS[subPlatform || "moonshot-cn"];
  const baseUrl = sub.baseUrl;

  // Kimi Code 浣跨敤 Anthropic Messages 鍗忚楠岃瘉
  if (subPlatform === "kimi-code") {
    return jsonRequest(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelID || "k2p5",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  }

  // moonshot-cn / moonshot-ai 浣跨敤 OpenAI 鍏煎 /models 鎺ュ彛
  return jsonRequest(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export function verifyGlm(apiKey: string, subPlatform?: string, modelID?: string): Promise<void> {
  const sub = getBuiltinSubPlatform("glm", subPlatform);
  if (!sub) throw new Error("Unknown GLM platform");
  return verifyCustom(apiKey, sub.baseUrl, sub.api, modelID);
}

export function verifyMinimax(apiKey: string, subPlatform?: string, modelID?: string): Promise<void> {
  const sub = getBuiltinSubPlatform("minimax", subPlatform);
  if (!sub) throw new Error("Unknown MiniMax platform");
  return verifyCustom(apiKey, sub.baseUrl, sub.api, modelID);
}

// Feishu credential verification via tenant_access_token.
export function verifyFeishu(appId: string, appSecret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const req = https.request(
      {
        hostname: "open.feishu.cn",
        path: "/open-apis/auth/v3/tenant_access_token/internal",
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.code === 0) {
              resolve();
            } else {
              reject(new Error(json.msg || `椋炰功楠岃瘉澶辫触 (code: ${json.code})`));
            }
          } catch {
            reject(new Error(`椋炰功鍝嶅簲瑙ｆ瀽澶辫触: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(body);
    req.end();
  });
}

// QQ Bot credential verification via getAppAccessToken.
export function verifyQqbot(appId: string, clientSecret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ appId, clientSecret });
    const req = https.request(
      {
        hostname: "bots.qq.com",
        path: "/app/getAppAccessToken",
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (typeof json.access_token === "string" && json.access_token.trim()) {
              resolve();
            } else {
              reject(new Error(json.message || json.msg || `QQ Bot 楠岃瘉澶辫触: ${data.slice(0, 200)}`));
            }
          } catch {
            reject(new Error(`QQ Bot 鍝嶅簲瑙ｆ瀽澶辫触: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(body);
    req.end();
  });
}

// DingTalk credential verification via accessToken.
export function verifyDingtalk(clientId: string, clientSecret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ appKey: clientId, appSecret: clientSecret });
    const req = https.request(
      {
        hostname: "api.dingtalk.com",
        path: "/v1.0/oauth2/accessToken",
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (typeof json.accessToken === "string" && json.accessToken.trim()) {
              resolve();
              return;
            }
            reject(
              new Error(
                json.message ||
                json.msg ||
                json.errmsg ||
                `閽夐拤楠岃瘉澶辫触: ${data.slice(0, 200)}`
              )
            );
          } catch {
            reject(new Error(`閽夐拤鍝嶅簲瑙ｆ瀽澶辫触: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(body);
    req.end();
  });
}

// Ollama 鏈湴楠岃瘉锛圙ET /api/tags 妫€鏌ユ湇鍔℃槸鍚﹁繍琛岋級
export async function verifyOllama(baseURL?: string): Promise<void> {
  const base = (baseURL || "http://localhost:11434").replace(/\/$/, "");
  await jsonRequest(`${base}/api/tags`, {});
}

// Custom provider verification by issuing a real chat/request call (not /models).
export async function verifyCustom(apiKey: string, baseURL?: string, apiType?: string, modelID?: string): Promise<void> {
  if (!baseURL) throw new Error("Custom provider requires Base URL");
  if (!modelID) throw new Error("Custom provider requires Model ID");
  const base = baseURL.replace(/\/$/, "");
  const hasTrailingV1 = /\/v1$/i.test(base);
  const anthropicEndpoint = hasTrailingV1 ? `${base}/messages` : `${base}/v1/messages`;
  const responsesEndpoint = hasTrailingV1 ? `${base}/responses` : `${base}/v1/responses`;
  const effectiveApiType = apiType || "openai-completions";

  let endpoint = "";
  let requestPayload: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {};

  if (effectiveApiType === "anthropic-messages") {
    endpoint = anthropicEndpoint;
    requestPayload = {
      method: "POST",
      headers: {
        "User-Agent": UA_ANTHROPIC,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelID,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    };
  } else if (effectiveApiType === "openai-responses") {
    endpoint = responsesEndpoint;
    requestPayload = {
      method: "POST",
      headers: {
        "User-Agent": UA_OPENAI,
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelID,
        input: "hi",
        // Keep verification payload aligned with runtime OpenAI Responses calls.
        store: false,
      }),
    };
  } else {
    endpoint = `${base}/chat/completions`;
    requestPayload = {
      method: "POST",
      headers: {
        "User-Agent": UA_OPENAI,
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelID,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    };
  }

  try {
    await jsonRequest(endpoint, requestPayload);
  } catch (err: any) {
    const detail = err?.message || String(err);
    throw new Error(`[verify:${effectiveApiType}] ${endpoint} model=${modelID}: ${detail}`);
  }
}

// 鈹€鈹€ 缁熶竴楠岃瘉鍏ュ彛锛堟牴?provider 鍚嶇О鍒嗘淳?鈹€鈹€


export function verifyOpenAIModels(apiKey: string, baseURL: string): Promise<void> {
  const base = baseURL.replace(/\/$/, "");
  const hasTrailingV1 = /\/v1$/i.test(base);
  const endpoint = hasTrailingV1 ? `${base}/models` : `${base}/v1/models`;
  return jsonRequest(endpoint, {
    method: "GET",
    headers: {
      "User-Agent": UA_OPENAI,
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
  });
}
export async function verifyProvider(params: {
  provider: string;
  apiKey?: string;
  baseURL?: string;
  subPlatform?: string;
  apiType?: string;
  modelID?: string;
  appId?: string;
  clientId?: string;
  appSecret?: string;
  clientSecret?: string;
  customPreset?: string;
}): Promise<{ success: boolean; message?: string }> {
  const {
    provider,
    apiKey,
    baseURL,
    subPlatform,
    apiType,
    modelID,
    appId,
    clientId,
    appSecret,
    clientSecret,
    customPreset,
  } = params;
  try {
    switch (provider) {
      case "wbsmodels":
        await verifyCustom(
          apiKey!,
          baseURL || PROVIDER_PRESETS.wbsmodels.baseUrl,
          apiType || PROVIDER_PRESETS.wbsmodels.api,
          modelID,
        );
        break;
      case "clawimage":
        await verifyClawimage(apiKey!, modelID, baseURL);
        break;
      case "moonshot":
        await verifyMoonshot(apiKey!, subPlatform, modelID);
        break;
      case "glm":
        await verifyGlm(apiKey!, subPlatform, modelID);
        break;
      case "minimax":
        await verifyMinimax(apiKey!, subPlatform, modelID);
        break;
      case "custom": {
        const customPre = customPreset ? CUSTOM_PROVIDER_PRESETS[customPreset] : undefined;
        // Ollama 鏈湴楠岃瘉锛欸ET /api/tags 妫€鏌ヨ繛閫氭€э紝鏃犻渶 API Key
        if (customPre?.keyOptional) {
          await verifyOllama(baseURL || customPre.baseUrl);
          break;
        }
        // 鍐呯疆棰勮鍛戒腑鏃讹紝浣跨敤棰勮?baseUrl ?api 杩涜楠岃瘉锛堝墠绔紶?baseURL 鏃朵紭鍏堬級
        const effectiveBaseURL = baseURL || (customPre ? customPre.baseUrl : undefined);
        const effectiveApiType = customPre ? customPre.api : apiType;
        await verifyCustom(apiKey!, effectiveBaseURL, effectiveApiType, modelID);
        break;
      }
      case "feishu":
        await verifyFeishu(appId!, appSecret!);
        break;
      case "qqbot":
        await verifyQqbot(appId!, clientSecret!);
        break;
      case "dingtalk":
        await verifyDingtalk(clientId!, clientSecret!);
        break;
      default:
        return { success: false, message: `鏈煡 Provider: ${provider}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err.message || String(err) };
  }
}

// 鈹€鈹€ HTTP 璇锋眰宸ュ叿 鈹€鈹€

// Keep User-Agent aligned with runtime SDK behavior.
const UA_ANTHROPIC = "Anthropic/JS 0.73.0";
const UA_OPENAI = "OpenAI/JS 6.10.0";

export function jsonRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);

    const req = mod.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: opts.method || "GET",
        headers: opts.headers,
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) {
            resolve();
          } else if (code === 401 || code === 403) {
            reject(new Error(`API key is invalid (${code})`));
          } else {
            reject(new Error(`HTTP ${code}: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
