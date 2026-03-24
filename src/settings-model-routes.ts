import {
  CUSTOM_PROVIDER_PRESETS,
  buildProviderConfig,
  getBuiltinSubPlatform,
  readUserConfig,
  saveSubPlatformConfig,
} from "./provider-config";
import {
  extractModelIds as extractModelIdsFromProviderConfig,
  extractProviderInfoFromRoute,
  type ProviderRoleMeta,
} from "./model-provider-utils";
import { saveKimiSearchConfig } from "./kimi-config";
import {
  type ModelRole,
  type ModelRouteConfig,
  migrateEmbeddedModelRoutesToSidecar,
  readUserConfigModelRoute,
  writeUserConfigModelRoute,
} from "./model-routes";

const MODEL_ROLES: ModelRole[] = ["thinking", "image", "video", "search"];
const NON_THINKING_MODEL_ROLES: ModelRole[] = ["image", "video", "search"];
const MODEL_ROLE_PROVIDER_KEYS: Record<ModelRole, string | null> = {
  thinking: null,
  image: "clawimage",
  video: "oneclaw-video",
  search: "oneclaw-search",
};
const CLAWIMAGE_PROVIDER_KEY = "clawimage";
const CLAWIMAGE_DEFAULT_MODEL_ID = "gemini-3.0-pro-image-2k";

type ProviderRouteMeta = ProviderRoleMeta & {
  route?: string;
};

export type SaveProviderInput = {
  role: ModelRole;
  provider: string;
  apiKey: string;
  modelID: string;
  baseURL?: string;
  api?: string;
  subPlatform?: string;
  supportImage?: boolean;
  customPreset?: string;
};

export function normalizeModelRole(roleRaw: unknown): ModelRole {
  if (typeof roleRaw !== "string") return "thinking";
  const normalized = roleRaw.trim().toLowerCase();
  return MODEL_ROLES.includes(normalized as ModelRole) ? (normalized as ModelRole) : "thinking";
}

function getRoleProviderStorageKey(role: ModelRole): string | null {
  return MODEL_ROLE_PROVIDER_KEYS[role] ?? null;
}

function normalizeModelRouteRecord(roleMeta: unknown): ProviderRouteMeta | null {
  if (!roleMeta || typeof roleMeta !== "object") return null;
  const record = roleMeta as Record<string, unknown>;
  return {
    route: typeof record.route === "string" ? record.route : undefined,
    provider: typeof record.provider === "string" ? record.provider : undefined,
    subPlatform: typeof record.subPlatform === "string" ? record.subPlatform : undefined,
    customPreset: typeof record.customPreset === "string" ? record.customPreset : undefined,
  };
}

export function cleanupLegacyModelRoutes(): void {
  // Compatibility no-op: model route metadata now lives in oneclaw.config.json.
}

export function migrateLegacyModelRoutesToUserConfig(config: any): boolean {
  return migrateEmbeddedModelRoutesToSidecar(config);
}

function readModelRouteMeta(config: any, role: ModelRole): ProviderRouteMeta | null {
  return normalizeModelRouteRecord(readUserConfigModelRoute(config, role));
}

function writeModelRouteMeta(config: any, role: ModelRole, meta: ProviderRouteMeta): void {
  writeUserConfigModelRoute(config, role, {
    route: meta.route ?? "",
    provider: meta.provider ?? "",
    ...(meta.subPlatform ? { subPlatform: meta.subPlatform } : {}),
    ...(meta.customPreset ? { customPreset: meta.customPreset } : {}),
  });
}

function ensureClawimageProviderConfig(config: any, fallbackApiKey?: string): string {
  config.models ??= {};
  config.models.providers ??= {};

  const existing = config.models.providers[CLAWIMAGE_PROVIDER_KEY];
  const existingApiKey =
    existing && typeof existing.apiKey === "string" ? existing.apiKey.trim() : "";
  const resolvedApiKey = existingApiKey || String(fallbackApiKey || "").trim();
  if (!resolvedApiKey) return "";

  const firstExistingModel =
    existing &&
    Array.isArray(existing.models) &&
    existing.models[0] &&
    typeof existing.models[0] === "object" &&
    typeof existing.models[0].id === "string"
      ? existing.models[0].id.trim()
      : "";
  const selectedModelId = firstExistingModel || CLAWIMAGE_DEFAULT_MODEL_ID;
  const providerConfig = buildProviderConfig("clawimage", resolvedApiKey, selectedModelId) as any;

  const mergedModels: any[] = [];
  const headModel =
    Array.isArray(providerConfig.models) && providerConfig.models[0]
      ? providerConfig.models[0]
      : { id: selectedModelId, name: selectedModelId };
  mergedModels.push(headModel);
  if (existing && Array.isArray(existing.models)) {
    for (const modelEntry of existing.models) {
      if (!modelEntry || typeof modelEntry !== "object") continue;
      if (modelEntry.id === headModel.id) continue;
      mergedModels.push(modelEntry);
    }
  }
  providerConfig.models = mergedModels;
  config.models.providers[CLAWIMAGE_PROVIDER_KEY] = providerConfig;
  return selectedModelId;
}

function ensureModelConfigContainer(config: any): void {
  config.models ??= {};
  config.models.providers ??= {};
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.model ??= {};
}

function readRoleRouteFromAgentDefaults(config: any, role: ModelRole): string {
  if (!config || typeof config !== "object") return "";
  const defaults = config?.agents?.defaults;
  if (!defaults || typeof defaults !== "object") return "";

  if (role === "thinking") {
    const route = defaults?.model?.primary;
    return typeof route === "string" ? route.trim() : "";
  }

  if (role === "image") {
    const imageModel = defaults?.imageModel;
    if (typeof imageModel === "string") {
      return imageModel.trim();
    }
    const route = imageModel?.primary;
    return typeof route === "string" ? route.trim() : "";
  }

  return "";
}

function writeRoleRouteToAgentDefaults(config: any, role: ModelRole, route: string): void {
  ensureModelConfigContainer(config);
  if (role === "thinking") {
    config.agents.defaults.model.primary = route;
    return;
  }
  if (role === "image") {
    const imageModel = config.agents.defaults.imageModel;
    if (imageModel && typeof imageModel === "object" && !Array.isArray(imageModel)) {
      imageModel.primary = route;
      config.agents.defaults.imageModel = imageModel;
    } else {
      config.agents.defaults.imageModel = { primary: route };
    }
  }
}

function resolveProviderStorageKey(
  role: ModelRole,
  provider: string,
  builtinSubPlatform: ReturnType<typeof getBuiltinSubPlatform>,
  customPreset?: string,
): string {
  const roleProviderStorageKey = getRoleProviderStorageKey(role);
  if (roleProviderStorageKey) return roleProviderStorageKey;
  if (builtinSubPlatform) return builtinSubPlatform.providerKey;
  const customPre = customPreset ? CUSTOM_PROVIDER_PRESETS[customPreset] : undefined;
  return customPre ? customPre.providerKey : provider;
}

function saveModelProviderConfig(config: any, input: SaveProviderInput): string {
  const { role, provider, apiKey, modelID, baseURL, api, subPlatform, supportImage, customPreset } = input;
  const builtinSubPlatform = getBuiltinSubPlatform(provider, subPlatform);
  const providerKey = resolveProviderStorageKey(role, provider, builtinSubPlatform, customPreset);
  const prevModels: any[] = config.models.providers[providerKey]?.models ?? [];

  if (builtinSubPlatform && role === "thinking") {
    saveSubPlatformConfig(config, provider, apiKey, modelID, subPlatform);
    mergeModels(config.models.providers[builtinSubPlatform.providerKey], modelID, prevModels);
    return builtinSubPlatform.providerKey;
  }

  const providerConfig = buildProviderConfig(
    provider,
    apiKey,
    modelID,
    builtinSubPlatform ? builtinSubPlatform.baseUrl : baseURL,
    builtinSubPlatform ? builtinSubPlatform.api : api,
    builtinSubPlatform ? true : supportImage,
    builtinSubPlatform ? "" : customPreset,
  );

  config.models.providers[providerKey] = providerConfig;
  mergeModels(config.models.providers[providerKey], modelID, prevModels);
  return providerKey;
}

function extractProviderInfo(
  config: any,
  options: { route?: string; roleMeta?: ProviderRouteMeta; role?: ModelRole } = {},
): any {
  const role = options.role ?? "thinking";
  const defaultRoute = readRoleRouteFromAgentDefaults(config, role);
  const roleMeta = options.roleMeta ?? {};
  const route =
    (typeof options.route === "string" && options.route.trim()) ||
    (typeof roleMeta.route === "string" && roleMeta.route.trim()) ||
    defaultRoute;
  const providers = config?.models?.providers ?? {};
  return extractProviderInfoFromRoute(providers, route, {
    provider: roleMeta.provider,
    subPlatform: roleMeta.subPlatform,
    customPreset: roleMeta.customPreset,
  });
}

function getFirstModelIdFromProvider(providerConfig: any): string {
  const modelIds = extractModelIdsFromProviderConfig(providerConfig);
  return modelIds[0] ?? "";
}

function buildUnconfiguredRoleState(savedProviders: Record<string, any>): any {
  return {
    provider: "",
    subPlatform: "",
    customPreset: "",
    modelID: "",
    apiKey: "",
    baseURL: "",
    api: "",
    supportsImage: true,
    configuredModels: [],
    raw: "",
    savedProviders,
    configured: false,
  };
}

export function buildModelRoleConfigMap(config: any): Record<ModelRole, any> {
  const thinkingMeta = readModelRouteMeta(config, "thinking") ?? undefined;
  const thinkingRoute = (thinkingMeta?.route || "").trim() || readRoleRouteFromAgentDefaults(config, "thinking");
  const thinkingInfo = extractProviderInfo(config, {
    role: "thinking",
    roleMeta: thinkingMeta,
    route: thinkingRoute,
  });
  const thinkingConfigured = !!(thinkingInfo?.provider && thinkingInfo?.modelID && thinkingInfo?.raw);
  const defaultUnconfiguredRoleState = buildUnconfiguredRoleState(thinkingInfo?.savedProviders ?? {});

  const modelRoles: Record<ModelRole, any> = {
    thinking: { ...thinkingInfo, configured: thinkingConfigured },
    image: { ...defaultUnconfiguredRoleState },
    video: { ...defaultUnconfiguredRoleState },
    search: { ...defaultUnconfiguredRoleState },
  };

  for (const role of NON_THINKING_MODEL_ROLES) {
    const roleMeta = readModelRouteMeta(config, role) ?? undefined;
    const roleProviderKey = getRoleProviderStorageKey(role);
    let route = (roleMeta?.route || "").trim() || readRoleRouteFromAgentDefaults(config, role);

    if (!route && roleProviderKey) {
      const firstModelId = getFirstModelIdFromProvider(config?.models?.providers?.[roleProviderKey]);
      if (firstModelId) {
        route = `${roleProviderKey}/${firstModelId}`;
      }
    }

    if (!route) {
      modelRoles[role] = { ...defaultUnconfiguredRoleState };
      continue;
    }

    const roleInfo = extractProviderInfo(config, { role, route, roleMeta });
    const roleConfigured = !!(roleInfo?.provider && roleInfo?.modelID && roleInfo?.raw);
    modelRoles[role] = roleConfigured
      ? { ...roleInfo, configured: true }
      : buildUnconfiguredRoleState(roleInfo?.savedProviders ?? defaultUnconfiguredRoleState.savedProviders);
  }

  return modelRoles;
}

function mergeModels(provEntry: any, selectedID: string, prevModels: any[]): void {
  if (!provEntry || !prevModels.length) return;
  const newEntry = (provEntry.models ?? [])[0];
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

export function saveSettingsModelProvider(config: any, input: SaveProviderInput): void {
  migrateLegacyModelRoutesToUserConfig(config);
  ensureModelConfigContainer(config);
  const routeProviderKey = saveModelProviderConfig(config, input);
  const route = `${routeProviderKey}/${input.modelID}`;

  writeRoleRouteToAgentDefaults(config, input.role, route);
  writeModelRouteMeta(config, input.role, {
    route,
    provider: input.provider,
    subPlatform: input.subPlatform,
    customPreset: input.customPreset,
  });

  if (input.role === "image" && input.provider === "clawimage") {
    ensureClawimageProviderConfig(config, input.apiKey);
  }

  if (input.role === "thinking" && input.provider === "moonshot" && input.subPlatform === "kimi-code") {
    saveKimiSearchConfig(config, { enabled: true });
  }
}

export function loadSettingsModelConfig(config = readUserConfig()) {
  if (migrateLegacyModelRoutesToUserConfig(config)) {
    return { config, migrated: true, modelRoles: buildModelRoleConfigMap(config) };
  }
  return { config, migrated: false, modelRoles: buildModelRoleConfigMap(config) };
}
