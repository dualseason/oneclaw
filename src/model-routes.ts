import {
  readOneclawConfig,
  writeOneclawConfig,
  type OneclawConfig,
} from "./oneclaw-config";

export type ModelRole = "thinking" | "image" | "video" | "search";

export interface ModelRouteConfig {
  route: string;
  provider: string;
  subPlatform?: string;
  customPreset?: string;
}

export function readUserConfigModelRoutes(
  config: any,
): Partial<Record<ModelRole, ModelRouteConfig>> {
  const sidecar = readStoredModelRoutes();
  if (Object.keys(sidecar).length > 0) {
    return sidecar;
  }
  const raw = config?.oneclaw?.modelRoutes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Partial<Record<ModelRole, ModelRouteConfig>>;
}

export function readUserConfigModelRoute(
  config: any,
  role: ModelRole,
): ModelRouteConfig | null {
  const routes = readUserConfigModelRoutes(config);
  const route = routes?.[role];
  if (!route || typeof route !== "object") {
    return null;
  }
  return route;
}

export function writeUserConfigModelRoute(
  config: any,
  role: ModelRole,
  route: ModelRouteConfig,
): void {
  const sidecar: OneclawConfig = readOneclawConfig() ?? {};
  const routes: Partial<Record<ModelRole, ModelRouteConfig>> = {
    ...(sidecar.modelRoutes ?? {}),
  };
  routes[role] = route;
  sidecar.modelRoutes = routes;
  writeOneclawConfig(sidecar);
  removeEmbeddedOneclawTopLevel(config);
}

export function migrateEmbeddedModelRoutesToSidecar(config: any): boolean {
  const hadEmbeddedOneclaw = hasEmbeddedOneclawTopLevel(config);
  const embedded = readEmbeddedModelRoutes(config);
  if (Object.keys(embedded).length > 0) {
    const sidecar: OneclawConfig = readOneclawConfig() ?? {};
    if (!sidecar.modelRoutes || Object.keys(sidecar.modelRoutes).length === 0) {
      sidecar.modelRoutes = embedded;
      writeOneclawConfig(sidecar);
    }
  }
  removeEmbeddedOneclawTopLevel(config);
  return hadEmbeddedOneclaw;
}

function readStoredModelRoutes(): Partial<Record<ModelRole, ModelRouteConfig>> {
  const sidecar = readOneclawConfig();
  const raw = sidecar?.modelRoutes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw;
}

function readEmbeddedModelRoutes(config: any): Partial<Record<ModelRole, ModelRouteConfig>> {
  const raw = config?.oneclaw?.modelRoutes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Partial<Record<ModelRole, ModelRouteConfig>>;
}

function hasEmbeddedOneclawTopLevel(config: any): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(config, "oneclaw");
}

function removeEmbeddedOneclawTopLevel(config: any): void {
  if (!hasEmbeddedOneclawTopLevel(config)) {
    return;
  }
  delete config.oneclaw;
}
