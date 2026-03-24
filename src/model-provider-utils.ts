import {
  CUSTOM_PROVIDER_PRESETS,
  GLM_SUB_PLATFORMS,
  MINIMAX_SUB_PLATFORMS,
  MOONSHOT_SUB_PLATFORMS,
} from "./provider-config";

export type ProviderRoleMeta = {
  provider?: string;
  subPlatform?: string;
  customPreset?: string;
};

export type SavedProviderEntry = {
  apiKey: string;
  baseURL: string;
  api: string;
  configuredModels: string[];
};

export type ExtractedProviderInfo = {
  provider: string;
  subPlatform: string;
  customPreset: string;
  modelID: string;
  apiKey: string;
  baseURL: string;
  api: string;
  supportsImage: boolean;
  configuredModels: string[];
  raw: string;
  savedProviders: Record<string, SavedProviderEntry>;
};

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function splitModelRoute(routeRaw: string): { providerKey: string; modelID: string } {
  const route = trimString(routeRaw);
  if (!route) return { providerKey: "", modelID: "" };
  const slashIdx = route.indexOf("/");
  if (slashIdx <= 0) return { providerKey: "", modelID: route };
  return {
    providerKey: route.slice(0, slashIdx),
    modelID: route.slice(slashIdx + 1),
  };
}

export function extractModelIds(providerConfig: any): string[] {
  if (!Array.isArray(providerConfig?.models)) return [];
  return providerConfig.models
    .map((m: any) => (typeof m === "string" ? m : m?.id))
    .filter((id: unknown): id is string => typeof id === "string" && !!id);
}

export function collectSavedProviders(providers: Record<string, any>): Record<string, SavedProviderEntry> {
  const savedProviders: Record<string, SavedProviderEntry> = {};
  for (const [key, providerConfig] of Object.entries(providers ?? {})) {
    if (!providerConfig || typeof providerConfig !== "object") continue;
    const p = providerConfig as any;
    if (!trimString(p.apiKey)) continue;
    savedProviders[key] = {
      apiKey: p.apiKey ?? "",
      baseURL: p.baseUrl ?? "",
      api: p.api ?? "",
      configuredModels: extractModelIds(p),
    };
  }
  return savedProviders;
}

function findCustomPresetByBaseUrl(providerKey: string, baseURL: string): string {
  if (!providerKey || !baseURL) return "";
  const matchedPreset = Object.entries(CUSTOM_PROVIDER_PRESETS).find(
    ([, preset]) => preset.providerKey === providerKey && preset.baseUrl === baseURL
  );
  return matchedPreset ? matchedPreset[0] : "";
}

function inferSubPlatform(providerKey: string, baseURL: string): string {
  const normalizedProviderKey = providerKey.toLowerCase();

  if (normalizedProviderKey === "kimi-coding") {
    return "kimi-code";
  }

  if (normalizedProviderKey === "moonshot") {
    return baseURL === MOONSHOT_SUB_PLATFORMS["moonshot-ai"].baseUrl ? "moonshot-ai" : "moonshot-cn";
  }

  if (normalizedProviderKey === "zai") {
    if (baseURL === GLM_SUB_PLATFORMS["glm-coding"].baseUrl) return "glm-coding";
    if (baseURL === GLM_SUB_PLATFORMS["glm-standard"].baseUrl) return "glm-standard";
  }

  if (normalizedProviderKey === "minimax" || normalizedProviderKey === "minimax-cn") {
    return normalizedProviderKey === "minimax-cn" || baseURL === MINIMAX_SUB_PLATFORMS["minimax-cn"].baseUrl
      ? "minimax-cn"
      : "minimax-global";
  }

  const moonshotMatch = Object.entries(MOONSHOT_SUB_PLATFORMS).find(([, preset]) => preset.baseUrl === baseURL);
  if (moonshotMatch) return moonshotMatch[0];

  const glmMatch = Object.entries(GLM_SUB_PLATFORMS).find(([, preset]) => preset.baseUrl === baseURL);
  if (glmMatch) return glmMatch[0];

  const minimaxMatch = Object.entries(MINIMAX_SUB_PLATFORMS).find(([, preset]) => preset.baseUrl === baseURL);
  if (minimaxMatch) return minimaxMatch[0];

  return "";
}

function normalizeProviderAlias(
  provider: string,
  providerKey: string,
  subPlatform: string,
  customPreset: string
): string {
  const normalizedProviderKey = providerKey.toLowerCase();
  const shouldDerive =
    !provider ||
    provider === providerKey ||
    provider.startsWith("oneclaw-");
  if (!shouldDerive) return provider;

  if (normalizedProviderKey === "kimi-coding" || subPlatform === "kimi-code") {
    return "moonshot";
  }
  if (normalizedProviderKey === "moonshot" || subPlatform.startsWith("moonshot-")) {
    return "moonshot";
  }
  if (normalizedProviderKey === "wbsmodels") {
    return "wbsmodels";
  }
  if (normalizedProviderKey === "zai" || subPlatform.startsWith("glm-")) {
    return "glm";
  }
  if (normalizedProviderKey === "minimax" || normalizedProviderKey === "minimax-cn" || subPlatform.startsWith("minimax-")) {
    return "minimax";
  }
  if (customPreset) {
    return "custom";
  }
  return providerKey;
}

function resolveSupportsImage(providerConfig: any, modelID: string): boolean {
  const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  const matchedModel = models.find((item: any) => item && typeof item === "object" && item.id === modelID);
  const modelEntry = matchedModel ?? models[0];
  if (modelEntry && typeof modelEntry === "object" && Array.isArray(modelEntry.input)) {
    return modelEntry.input.includes("image");
  }
  return true;
}

export function extractProviderInfoFromRoute(
  providers: Record<string, any>,
  routeRaw: string,
  roleMeta: ProviderRoleMeta = {}
): ExtractedProviderInfo {
  const route = trimString(routeRaw);
  const { providerKey, modelID } = splitModelRoute(route);
  const providerConfig = providers[providerKey] ?? {};

  let provider = trimString(roleMeta.provider) || providerKey;
  let subPlatform = trimString(roleMeta.subPlatform);
  let customPreset = trimString(roleMeta.customPreset);

  const apiKey = providerConfig?.apiKey ?? "";
  const baseURL = providerConfig?.baseUrl ?? "";
  const api = providerConfig?.api ?? "";
  const configuredModels = extractModelIds(providerConfig);
  const savedProviders = collectSavedProviders(providers);

  if (!customPreset) {
    customPreset = findCustomPresetByBaseUrl(providerKey, baseURL);
    if (customPreset) {
      provider = "custom";
    }
  }

  if (!subPlatform) {
    subPlatform = inferSubPlatform(providerKey, baseURL);
  }

  provider = normalizeProviderAlias(provider, providerKey, subPlatform, customPreset);

  return {
    provider,
    subPlatform,
    customPreset,
    modelID,
    apiKey,
    baseURL,
    api,
    supportsImage: resolveSupportsImage(providerConfig, modelID),
    configuredModels,
    raw: route,
    savedProviders,
  };
}
