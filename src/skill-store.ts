import { app, ipcMain } from "electron";
import { execFile } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import {
  resolveClawhubEntry,
  resolveNodeBin,
  resolveNodeExtraEnv,
  resolveUserBinDir,
  resolveUserStateDir,
} from "./constants";
import * as log from "./logger";
import { readOneclawConfig, writeOneclawConfig } from "./oneclaw-config";

const DEFAULT_REGISTRY = "https://skillhub.tencent.com";
const TENCENT_SKILLHUB_DATA_URL =
  "https://cloudcache.tencentcs.com/qcloud/tea/app/data/skills.2d46363b.json?max_age=31536000";
const DEPRECATED_REGISTRIES = new Set([
  "https://clawhub.ai",
  "https://www.clawhub.ai",
]);
const FETCH_TIMEOUT_MS = 15_000;
const TENCENT_SKILLHUB_CACHE_TTL_MS = 5 * 60_000;
const SKILL_STORE_CONFIG = "skill-store.json";

const debugLog = (msg: string) => {
  if (!app.isPackaged) log.info(`[skill-store] ${msg}`);
};

export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  version: string;
  downloads: number;
  highlighted: boolean;
  updatedAt: string;
  author: string;
};

export type SkillDetail = SkillSummary & {
  readme: string;
  author: string;
  tags: string[];
};

type ListResult = {
  skills: SkillSummary[];
  nextCursor: string | null;
};

type SkillOperationResult = {
  success: boolean;
  message?: string;
};

type TencentSkillHubItem = {
  slug?: string;
  name?: string;
  description?: string;
  description_zh?: string;
  version?: string;
  homepage?: string;
  tags?: string[];
  downloads?: number;
  stars?: number;
  installs?: number;
  updated_at?: number | string;
  score?: number;
  owner?: string;
};

type TencentSkillHubCatalog = {
  total?: number;
  generated_at?: string;
  featured?: string[];
  categories?: Record<string, string[]>;
  skills?: TencentSkillHubItem[];
};

type SkillStoreBackend = "tencent-skillhub" | "legacy-registry";

let tencentCatalogCache:
  | {
      expiresAt: number;
      data: TencentSkillHubCatalog;
    }
  | null = null;
let tencentCatalogPromise: Promise<TencentSkillHubCatalog> | null = null;

function skillStoreConfigPath(): string {
  return path.join(resolveUserStateDir(), SKILL_STORE_CONFIG);
}

function readLegacySkillStoreConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(skillStoreConfigPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeLegacySkillStoreConfig(data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(skillStoreConfigPath()), { recursive: true });
  fs.writeFileSync(
    skillStoreConfigPath(),
    JSON.stringify(data, null, 2) + "\n",
    "utf-8",
  );
}

export function readSkillStoreRegistry(): string {
  const oneclawConfig = readOneclawConfig();
  if (oneclawConfig?.skillStore?.registryUrl) {
    const migrated = migrateDeprecatedRegistryUrl(oneclawConfig.skillStore.registryUrl);
    if (migrated !== oneclawConfig.skillStore.registryUrl) {
      writeSkillStoreRegistry(migrated);
    }
    return migrated;
  }

  const legacy = readLegacySkillStoreConfig();
  if (typeof legacy?.registryUrl === "string") {
    const migrated = migrateDeprecatedRegistryUrl(legacy.registryUrl);
    if (migrated !== legacy.registryUrl) {
      writeSkillStoreRegistry(migrated);
    }
    return migrated;
  }

  return "";
}

export function writeSkillStoreRegistry(url: string): void {
  const normalizedUrl = normalizeRegistryUrl(url);
  const config = readOneclawConfig();

  if (config) {
    if (normalizedUrl) {
      config.skillStore ??= {};
      config.skillStore.registryUrl = normalizedUrl;
    } else {
      delete config.skillStore?.registryUrl;
    }
    writeOneclawConfig(config);
  }

  const legacyConfig = readLegacySkillStoreConfig();
  if (normalizedUrl) {
    legacyConfig.registryUrl = normalizedUrl;
  } else {
    delete legacyConfig.registryUrl;
  }
  writeLegacySkillStoreConfig(legacyConfig);
}

function registryUrl(): string {
  const custom = readSkillStoreRegistry();
  if (custom.trim()) {
    return custom.trim().replace(/\/+$/, "");
  }
  return DEFAULT_REGISTRY;
}

function normalizeRegistryUrl(url: string): string {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

function migrateDeprecatedRegistryUrl(url: string): string {
  const normalized = normalizeRegistryUrl(url);
  if (!normalized) {
    return "";
  }
  if (DEPRECATED_REGISTRIES.has(normalized)) {
    return DEFAULT_REGISTRY;
  }
  return normalized;
}

function resolveSkillStoreBackend(): SkillStoreBackend {
  return isTencentSkillHubRegistry(registryUrl()) ? "tencent-skillhub" : "legacy-registry";
}

function isTencentSkillHubRegistry(url: string): boolean {
  try {
    return new URL(url).hostname === "skillhub.tencent.com";
  } catch {
    return false;
  }
}

function jsonGet<T>(url: string): Promise<T> {
  debugLog(`GET ${url}`);
  const startMs = Date.now();

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;

    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        debugLog(`GET ${url} -> ${res.statusCode} (${Date.now() - startMs}ms)`);
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        debugLog(`GET ${url} -> ${res.statusCode} ${body.length}B (${Date.now() - startMs}ms)`);
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          debugLog(`GET ${url} -> JSON parse error: ${String(err)}`);
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      debugLog(`GET ${url} -> error: ${err.message} (${Date.now() - startMs}ms)`);
      reject(err);
    });

    req.on("timeout", () => {
      debugLog(`GET ${url} -> timeout (${Date.now() - startMs}ms)`);
      req.destroy();
      reject(new Error("request timeout"));
    });
  });
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeIsoDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return "";
}

function preferredTencentDescription(item: TencentSkillHubItem): string {
  const zh = String(item.description_zh ?? "").trim();
  if (zh) {
    return zh;
  }
  return String(item.description ?? "").trim();
}

function buildTencentReadme(item: TencentSkillHubItem): string {
  const title = String(item.name ?? item.slug ?? "Skill").trim();
  const description = preferredTencentDescription(item);
  const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
  const sections = [`# ${title}`];

  if (description) {
    sections.push(description);
  }

  if (tags.length > 0) {
    sections.push(`Tags: ${tags.join(", ")}`);
  }

  const owner = String(item.owner ?? "").trim();
  if (owner) {
    sections.push(`Owner: ${owner}`);
  }

  return sections.join("\n\n").trim();
}

function mapLegacyItem(raw: any): SkillSummary {
  return {
    slug: raw.slug ?? "",
    name: raw.displayName ?? raw.slug ?? "",
    description: raw.summary ?? "",
    version: raw.tags?.latest ?? raw.latestVersion?.version ?? raw.version ?? "",
    downloads: raw.stats?.downloads ?? raw.downloads ?? 0,
    highlighted: true,
    updatedAt: raw.updatedAt ? new Date(raw.updatedAt).toISOString() : "",
    author: raw.author ?? raw.owner ?? "",
  };
}

function mapTencentItem(raw: TencentSkillHubItem, featured: Set<string>): SkillSummary {
  const slug = String(raw.slug ?? "").trim();
  return {
    slug,
    name: String(raw.name ?? slug).trim() || slug,
    description: preferredTencentDescription(raw),
    version: String(raw.version ?? "").trim(),
    downloads: safeNumber(raw.downloads),
    highlighted: featured.has(slug),
    updatedAt: normalizeIsoDate(raw.updated_at),
    author: String(raw.owner ?? "").trim(),
  };
}

async function loadTencentSkillHubCatalog(): Promise<TencentSkillHubCatalog> {
  const now = Date.now();
  if (tencentCatalogCache && tencentCatalogCache.expiresAt > now) {
    return tencentCatalogCache.data;
  }
  if (tencentCatalogPromise) {
    return tencentCatalogPromise;
  }

  tencentCatalogPromise = jsonGet<TencentSkillHubCatalog>(TENCENT_SKILLHUB_DATA_URL)
    .then((data) => {
      tencentCatalogCache = {
        data,
        expiresAt: Date.now() + TENCENT_SKILLHUB_CACHE_TTL_MS,
      };
      return data;
    })
    .finally(() => {
      tencentCatalogPromise = null;
    });

  return tencentCatalogPromise;
}

function getTencentItems(catalog: TencentSkillHubCatalog): TencentSkillHubItem[] {
  return Array.isArray(catalog.skills) ? catalog.skills.filter(Boolean) : [];
}

function getTencentFeaturedSet(catalog: TencentSkillHubCatalog): Set<string> {
  return new Set(
    Array.isArray(catalog.featured)
      ? catalog.featured
          .map((value) => String(value ?? "").trim())
          .filter(Boolean)
      : [],
  );
}

function compareTencentSkills(
  a: TencentSkillHubItem,
  b: TencentSkillHubItem,
  sort: string | undefined,
): number {
  const normalizedSort = String(sort ?? "trending").toLowerCase();

  if (normalizedSort === "downloads") {
    return (
      safeNumber(b.downloads) - safeNumber(a.downloads) ||
      safeNumber(b.score) - safeNumber(a.score) ||
      String(a.name ?? a.slug ?? "").localeCompare(String(b.name ?? b.slug ?? ""))
    );
  }

  if (normalizedSort === "updated") {
    return (
      (Date.parse(normalizeIsoDate(b.updated_at)) || 0) -
        (Date.parse(normalizeIsoDate(a.updated_at)) || 0) ||
      safeNumber(b.score) - safeNumber(a.score) ||
      String(a.name ?? a.slug ?? "").localeCompare(String(b.name ?? b.slug ?? ""))
    );
  }

  return (
    safeNumber(b.score) - safeNumber(a.score) ||
    safeNumber(b.installs) - safeNumber(a.installs) ||
    safeNumber(b.downloads) - safeNumber(a.downloads) ||
    String(a.name ?? a.slug ?? "").localeCompare(String(b.name ?? b.slug ?? ""))
  );
}

function paginateSkills(
  skills: SkillSummary[],
  limit: number | undefined,
  cursor: string | undefined,
): ListResult {
  const pageSize = Math.max(1, Math.min(Number(limit) || 20, 100));
  const offset = Math.max(0, Number.parseInt(String(cursor ?? "0"), 10) || 0);
  const nextOffset = offset + pageSize;

  return {
    skills: skills.slice(offset, nextOffset),
    nextCursor: nextOffset < skills.length ? String(nextOffset) : null,
  };
}

async function listTencentSkillHubSkills(opts: {
  sort?: string;
  limit?: number;
  cursor?: string;
}): Promise<ListResult> {
  const catalog = await loadTencentSkillHubCatalog();
  const featured = getTencentFeaturedSet(catalog);
  const mapped = getTencentItems(catalog)
    .sort((a, b) => compareTencentSkills(a, b, opts.sort))
    .map((item) => mapTencentItem(item, featured))
    .filter((item) => item.slug);

  return paginateSkills(mapped, opts.limit, opts.cursor);
}

function computeTencentSearchScore(item: TencentSkillHubItem, needle: string): number {
  const slug = String(item.slug ?? "").toLowerCase();
  const name = String(item.name ?? "").toLowerCase();
  const description = preferredTencentDescription(item).toLowerCase();
  const owner = String(item.owner ?? "").toLowerCase();
  const tags = Array.isArray(item.tags)
    ? item.tags.map((tag) => String(tag).toLowerCase())
    : [];

  let score = 0;
  if (slug === needle) score += 200;
  else if (slug.startsWith(needle)) score += 120;
  else if (slug.includes(needle)) score += 80;

  if (name === needle) score += 220;
  else if (name.startsWith(needle)) score += 140;
  else if (name.includes(needle)) score += 100;

  if (owner === needle) score += 60;
  else if (owner.includes(needle)) score += 30;

  if (tags.some((tag) => tag === needle)) score += 90;
  else if (tags.some((tag) => tag.includes(needle))) score += 45;

  if (description.includes(needle)) score += 25;

  return score;
}

async function searchTencentSkillHubSkills(opts: {
  q: string;
  limit?: number;
}): Promise<{ skills: SkillSummary[] }> {
  const needle = String(opts.q ?? "").trim().toLowerCase();
  if (!needle) {
    return { skills: [] };
  }

  const catalog = await loadTencentSkillHubCatalog();
  const featured = getTencentFeaturedSet(catalog);
  const items = getTencentItems(catalog)
    .map((item) => ({ item, score: computeTencentSearchScore(item, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      return (
        b.score - a.score ||
        safeNumber(b.item.score) - safeNumber(a.item.score) ||
        safeNumber(b.item.downloads) - safeNumber(a.item.downloads)
      );
    })
    .slice(0, Math.max(1, Math.min(Number(opts.limit) || 20, 100)))
    .map((entry) => mapTencentItem(entry.item, featured))
    .filter((item) => item.slug);

  return { skills: items };
}

async function getTencentSkillHubDetail(slug: string): Promise<SkillDetail> {
  const trimmed = String(slug ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing skill slug");
  }

  const catalog = await loadTencentSkillHubCatalog();
  const featured = getTencentFeaturedSet(catalog);
  const item = getTencentItems(catalog).find((entry) => String(entry.slug ?? "").trim() === trimmed);
  if (!item) {
    throw new Error(`Skill not found: ${trimmed}`);
  }

  return {
    ...mapTencentItem(item, featured),
    readme: buildTencentReadme(item),
    author: String(item.owner ?? "").trim(),
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag)) : [],
  };
}

async function listLegacySkills(opts: {
  sort?: string;
  limit?: number;
  cursor?: string;
}): Promise<ListResult> {
  const base = registryUrl();
  const params = new URLSearchParams();
  params.set("highlightedOnly", "true");
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);

  const raw = await jsonGet<any>(`${base}/api/v1/skills?${params}`);
  const items = Array.isArray(raw.items)
    ? raw.items
    : Array.isArray(raw.skills)
      ? raw.skills
      : [];

  return {
    skills: items.map(mapLegacyItem),
    nextCursor: raw.nextCursor ?? null,
  };
}

async function searchLegacySkills(opts: {
  q: string;
  limit?: number;
}): Promise<{ skills: SkillSummary[] }> {
  const base = registryUrl();
  const params = new URLSearchParams();
  params.set("q", opts.q);
  if (opts.limit) params.set("limit", String(opts.limit));

  const raw = await jsonGet<any>(`${base}/api/v1/search?${params}`);
  const items = Array.isArray(raw.results)
    ? raw.results
    : Array.isArray(raw.items)
      ? raw.items
      : [];

  return { skills: items.map(mapLegacyItem) };
}

async function getLegacySkillDetail(slug: string): Promise<SkillDetail> {
  const base = registryUrl();
  const raw = await jsonGet<any>(`${base}/api/v1/skills/${encodeURIComponent(slug)}`);
  return {
    ...mapLegacyItem(raw),
    readme: raw.readme ?? "",
    author: raw.author ?? raw.owner ?? "",
    tags: Array.isArray(raw.tagsList) ? raw.tagsList : [],
  };
}

async function listSkills(opts: {
  sort?: string;
  limit?: number;
  cursor?: string;
}): Promise<ListResult> {
  return resolveSkillStoreBackend() === "tencent-skillhub"
    ? listTencentSkillHubSkills(opts)
    : listLegacySkills(opts);
}

async function searchSkills(opts: {
  q: string;
  limit?: number;
}): Promise<{ skills: SkillSummary[] }> {
  return resolveSkillStoreBackend() === "tencent-skillhub"
    ? searchTencentSkillHubSkills(opts)
    : searchLegacySkills(opts);
}

async function getSkillDetail(slug: string): Promise<SkillDetail> {
  return resolveSkillStoreBackend() === "tencent-skillhub"
    ? getTencentSkillHubDetail(slug)
    : getLegacySkillDetail(slug);
}

function workspaceDir(): string {
  return path.join(resolveUserStateDir(), "workspace");
}

function skillsBaseDir(): string {
  return path.join(workspaceDir(), "skills");
}

function execClawhub(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const nodeBin = resolveNodeBin();
  const clawhubEntry = resolveClawhubEntry();
  const registry = registryUrl();
  const workdir = workspaceDir();
  const fullArgs = [clawhubEntry, "--workdir", workdir, "--registry", registry, "--no-input", ...args];

  debugLog(`exec: ${nodeBin} ${fullArgs.join(" ")}`);

  return new Promise((resolve, reject) => {
    const userBinDir = resolveUserBinDir();
    const envPath = userBinDir + path.delimiter + (process.env.PATH ?? "");

    execFile(
      nodeBin,
      fullArgs,
      {
        timeout: 60_000,
        env: {
          ...process.env,
          ...resolveNodeExtraEnv(),
          PATH: envPath,
        },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const errOut = typeof stderr === "string" ? stderr : "";

        debugLog(
          `exec result: exit=${err ? (err as any).code ?? "error" : 0} stdout=${out.length}B stderr=${errOut.length}B`,
        );
        if (errOut.trim()) debugLog(`exec stderr: ${errOut.trim()}`);

        if (err) {
          reject(new Error(errOut.trim() || err.message));
          return;
        }

        resolve({ stdout: out, stderr: errOut });
      },
    );
  });
}

async function installSkill(slug: string): Promise<SkillOperationResult> {
  if (resolveSkillStoreBackend() === "tencent-skillhub") {
    return {
      success: false,
      message:
        "\u817e\u8baf SkillHub \u76ee\u5f55\u5df2\u63a5\u901a\uff0c\u4f46\u5b83\u6ca1\u6709\u517c\u5bb9\u5f53\u524d\u5185\u7f6e ClawHub CLI \u7684\u5b89\u88c5\u63a5\u53e3\uff0c\u6682\u65f6\u53ea\u652f\u6301\u6d4f\u89c8\u548c\u641c\u7d22\u3002",
    };
  }

  try {
    await execClawhub(["install", slug]);
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err?.message ?? String(err) };
  }
}

function resolveInstalledSlug(nameOrSlug: string): string {
  const installed = listInstalledSkills();
  if (installed.includes(nameOrSlug)) {
    return nameOrSlug;
  }

  const base = skillsBaseDir();
  const needle = nameOrSlug.toLowerCase();
  for (const dir of installed) {
    try {
      const md = fs.readFileSync(path.join(base, dir, "SKILL.md"), "utf-8");
      const fm = md.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      if (fm && fm[1].trim().toLowerCase() === needle) return dir;
      const h1 = md.match(/^#\s+(.+)/m);
      if (h1 && h1[1].trim().toLowerCase() === needle) return dir;
    } catch {
      // Skip unreadable skill metadata.
    }
  }

  return nameOrSlug;
}

async function uninstallSkill(slug: string): Promise<SkillOperationResult> {
  try {
    const resolved = resolveInstalledSlug(slug);
    debugLog(`uninstall: "${slug}" -> resolved="${resolved}"`);
    await execClawhub(["uninstall", "--yes", resolved]);
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err?.message ?? String(err) };
  }
}

function listInstalledSkills(): string[] {
  const base = skillsBaseDir();
  if (!fs.existsSync(base)) return [];

  try {
    return fs.readdirSync(base).filter((name) => {
      const dir = path.join(base, name);
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "SKILL.md"));
    });
  } catch {
    return [];
  }
}

export function registerSkillStoreIpc(): void {
  ipcMain.handle("skill-store:list", async (_event, params) => {
    debugLog(
      `ipc list sort=${params?.sort} limit=${params?.limit} cursor=${params?.cursor ?? "none"} backend=${resolveSkillStoreBackend()}`,
    );
    try {
      const result = await listSkills({
        sort: params?.sort,
        limit: params?.limit,
        cursor: params?.cursor,
      });
      debugLog(`ipc list -> ${result.skills?.length ?? 0} skills`);
      return { success: true, data: result };
    } catch (err: any) {
      debugLog(`ipc list -> error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  ipcMain.handle("skill-store:search", async (_event, params) => {
    debugLog(`ipc search q="${params?.q}" limit=${params?.limit}`);
    try {
      const result = await searchSkills({
        q: params?.q ?? "",
        limit: params?.limit,
      });
      debugLog(`ipc search -> ${result.skills?.length ?? 0} skills`);
      return { success: true, data: result };
    } catch (err: any) {
      debugLog(`ipc search -> error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  ipcMain.handle("skill-store:detail", async (_event, params) => {
    debugLog(`ipc detail slug=${params?.slug}`);
    try {
      const result = await getSkillDetail(params?.slug ?? "");
      debugLog(`ipc detail -> ${result.name ?? "unknown"}`);
      return { success: true, data: result };
    } catch (err: any) {
      debugLog(`ipc detail -> error: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  ipcMain.handle("skill-store:install", async (_event, params) => {
    debugLog(`ipc install slug=${params?.slug}`);
    const result = await installSkill(params?.slug ?? "");
    debugLog(`ipc install -> ${result.success ? "ok" : result.message}`);
    return result;
  });

  ipcMain.handle("skill-store:uninstall", async (_event, params) => {
    debugLog(`ipc uninstall slug=${params?.slug}`);
    const result = await uninstallSkill(params?.slug ?? "");
    debugLog(`ipc uninstall -> ${result.success ? "ok" : result.message}`);
    return result;
  });

  ipcMain.handle("skill-store:list-installed", async () => {
    const installed = listInstalledSkills();
    debugLog(`ipc list-installed -> [${installed.join(", ")}]`);
    return { success: true, data: installed };
  });
}
