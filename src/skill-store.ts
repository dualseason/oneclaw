import { app, ipcMain } from "electron";
import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
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

const extractZip = require("extract-zip") as (
  zipPath: string,
  options: { dir: string },
) => Promise<void>;

const DEFAULT_REGISTRY = "https://skillhub.tencent.com";
const TENCENT_SKILLHUB_DATA_URL =
  "https://cloudcache.tencentcs.com/qcloud/tea/app/data/skills.2d46363b.json?max_age=31536000";
const TENCENT_SKILLHUB_SEARCH_URL = "https://lightmake.site/api/v1/search";
const TENCENT_SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE =
  "https://lightmake.site/api/v1/download?slug={slug}";
const TENCENT_SKILLHUB_FALLBACK_DOWNLOAD_URL_TEMPLATE =
  "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills/{slug}.zip";
const DEPRECATED_REGISTRIES = new Set([
  "https://clawhub.ai",
  "https://www.clawhub.ai",
]);
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const TENCENT_SKILLHUB_CACHE_TTL_MS = 5 * 60_000;
const SKILL_STORE_CONFIG = "skill-store.json";
const SKILLS_STORE_LOCKFILE = ".skills_store_lock.json";
const CLAWHUB_LOCKFILE_RELATIVE_PATH = path.join(".clawhub", "lock.json");

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
  homepage?: string;
};

export type SkillDetail = SkillSummary & {
  readme: string;
  author: string;
  tags: string[];
  homepage?: string;
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

type TencentSkillHubSearchResponse = {
  results?: TencentSkillHubItem[];
  items?: TencentSkillHubItem[];
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

function fillSlugTemplate(template: string, slug: string): string {
  const raw = String(template ?? "").trim();
  if (!raw) {
    return "";
  }
  return raw.includes("{slug}") ? raw.replaceAll("{slug}", encodeURIComponent(slug)) : raw;
}

function sanitizeSkillHomepage(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (
      hostname.includes("clawhub.ai") ||
      hostname.includes("oneclaw.cn") ||
      hostname.includes("www.oneclaw.cn")
    ) {
      return "";
    }
    return raw;
  } catch {
    return "";
  }
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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
    homepage: sanitizeSkillHomepage(raw.homepage),
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
    homepage: sanitizeSkillHomepage(raw.homepage),
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
    homepage: sanitizeSkillHomepage(item.homepage),
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
    homepage: sanitizeSkillHomepage(raw.homepage),
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

async function fetchTencentRemoteSearchExact(slug: string): Promise<TencentSkillHubItem | null> {
  const trimmed = String(slug ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const params = new URLSearchParams({
    q: trimmed,
    limit: "20",
  });
  const raw = await jsonGet<TencentSkillHubSearchResponse>(`${TENCENT_SKILLHUB_SEARCH_URL}?${params}`);
  const items = Array.isArray(raw.results)
    ? raw.results
    : Array.isArray(raw.items)
      ? raw.items
      : [];
  return (
    items.find((item) => String(item?.slug ?? "").trim() === trimmed) ?? null
  );
}

function downloadBuffer(url: string, redirectCount = 0): Promise<Buffer> {
  debugLog(`DOWNLOAD ${url}`);
  const startMs = Date.now();

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(
      url,
      {
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers: {
          "User-Agent": "oneclaw-skill-store",
          Accept: "*/*",
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = res.headers.location;

        if (
          location &&
          [301, 302, 303, 307, 308].includes(statusCode) &&
          redirectCount < MAX_DOWNLOAD_REDIRECTS
        ) {
          const nextUrl = new URL(location, url).toString();
          debugLog(`DOWNLOAD ${url} -> redirect ${statusCode} ${nextUrl}`);
          res.resume();
          downloadBuffer(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          debugLog(`DOWNLOAD ${url} -> ${statusCode} (${Date.now() - startMs}ms)`);
          res.resume();
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          debugLog(`DOWNLOAD ${url} -> ${statusCode} ${body.length}B (${Date.now() - startMs}ms)`);
          resolve(body);
        });
      },
    );

    req.on("error", (err) => {
      debugLog(`DOWNLOAD ${url} -> error: ${err.message} (${Date.now() - startMs}ms)`);
      reject(err);
    });

    req.on("timeout", () => {
      debugLog(`DOWNLOAD ${url} -> timeout (${Date.now() - startMs}ms)`);
      req.destroy();
      reject(new Error("request timeout"));
    });
  });
}

async function downloadBufferWithFallback(
  urls: string[],
  opts?: { expectedSha256?: string },
): Promise<{ body: Buffer; url: string }> {
  const seen = new Set<string>();
  const candidates = urls.map((value) => String(value ?? "").trim()).filter((value) => {
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });

  if (candidates.length === 0) {
    throw new Error("No download URL candidates available");
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const body = await downloadBuffer(candidate);
      if (opts?.expectedSha256) {
        const actual = sha256Hex(body);
        if (actual !== opts.expectedSha256) {
          throw new Error(
            `SHA256 mismatch: expected ${opts.expectedSha256}, got ${actual}`,
          );
        }
      }
      return { body, url: candidate };
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Download failed");
}

function skillStoreLockPath(): string {
  return path.join(workspaceDir(), SKILLS_STORE_LOCKFILE);
}

function clawhubLockPath(): string {
  return path.join(workspaceDir(), CLAWHUB_LOCKFILE_RELATIVE_PATH);
}

function readJsonObject(filePath: string): Record<string, any> {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function updateSkillStoreLocks(entry: {
  slug: string;
  name: string;
  version: string;
  primaryZipUrl: string;
}): void {
  const lockPath = skillStoreLockPath();
  const lock = readJsonObject(lockPath);
  lock.version = 1;
  if (!lock.skills || typeof lock.skills !== "object" || Array.isArray(lock.skills)) {
    lock.skills = {};
  }
  lock.skills[entry.slug] = {
    name: entry.name,
    zip_url: entry.primaryZipUrl,
    source: "skillhub",
    version: entry.version,
  };
  writeJsonFile(lockPath, lock);

  const compatLockPath = clawhubLockPath();
  const compatLock = readJsonObject(compatLockPath);
  compatLock.version = 1;
  if (
    !compatLock.skills ||
    typeof compatLock.skills !== "object" ||
    Array.isArray(compatLock.skills)
  ) {
    compatLock.skills = {};
  }
  compatLock.skills[entry.slug] = {
    version: entry.version,
    installedAt: Date.now(),
  };
  writeJsonFile(compatLockPath, compatLock);
}

function removeSkillStoreLocks(slug: string): void {
  const lockPath = skillStoreLockPath();
  const lock = readJsonObject(lockPath);
  if (lock.skills && typeof lock.skills === "object" && !Array.isArray(lock.skills)) {
    delete lock.skills[slug];
    lock.version = 1;
    writeJsonFile(lockPath, lock);
  }

  const compatLockPath = clawhubLockPath();
  const compatLock = readJsonObject(compatLockPath);
  if (
    compatLock.skills &&
    typeof compatLock.skills === "object" &&
    !Array.isArray(compatLock.skills)
  ) {
    delete compatLock.skills[slug];
    compatLock.version = 1;
    writeJsonFile(compatLockPath, compatLock);
  }
}

async function installTencentSkill(slug: string): Promise<SkillOperationResult> {
  const trimmed = String(slug ?? "").trim();
  if (!trimmed) {
    return { success: false, message: "Missing skill slug" };
  }

  try {
    let catalogSkill: TencentSkillHubItem | undefined;
    try {
      const catalog = await loadTencentSkillHubCatalog();
      catalogSkill = getTencentItems(catalog).find(
        (item) => String(item.slug ?? "").trim() === trimmed,
      );
    } catch (err: any) {
      debugLog(`catalog lookup failed for ${trimmed}: ${err?.message ?? err}`);
    }
    let remoteSkill: TencentSkillHubItem | null = null;
    if (!catalogSkill) {
      try {
        remoteSkill = await fetchTencentRemoteSearchExact(trimmed);
      } catch (err: any) {
        debugLog(`remote search fallback failed for ${trimmed}: ${err?.message ?? err}`);
      }
    }
    const skill =
      catalogSkill ??
      remoteSkill ??
      ({ slug: trimmed, name: trimmed, version: "", owner: "" } satisfies TencentSkillHubItem);

    const primaryZipUrl = fillSlugTemplate(TENCENT_SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE, trimmed);
    const fallbackZipUrl = fillSlugTemplate(
      TENCENT_SKILLHUB_FALLBACK_DOWNLOAD_URL_TEMPLATE,
      trimmed,
    );
    const expectedSha256 = String((skill as any)?.sha256 ?? "").trim().toLowerCase();
    const targetDir = path.join(skillsBaseDir(), trimmed);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-skillhub-"));

    try {
      const zipPath = path.join(tempDir, `${trimmed}.zip`);
      const stageDir = path.join(tempDir, "stage");
      const { body } = await downloadBufferWithFallback(
        [primaryZipUrl, fallbackZipUrl],
        expectedSha256 ? { expectedSha256 } : undefined,
      );
      fs.writeFileSync(zipPath, body);
      fs.mkdirSync(stageDir, { recursive: true });
      await extractZip(zipPath, { dir: stageDir });

      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(stageDir, targetDir, { recursive: true, force: true });

      updateSkillStoreLocks({
        slug: trimmed,
        name: String(skill.name ?? trimmed).trim() || trimmed,
        version: String(skill.version ?? "").trim(),
        primaryZipUrl,
      });

      return {
        success: true,
        message: `已安装 ${String(skill.name ?? trimmed).trim() || trimmed}`,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err: any) {
    return {
      success: false,
      message: `安装失败：${err?.message ?? String(err)}`,
    };
  }
}

async function uninstallTencentSkill(slug: string): Promise<SkillOperationResult> {
  const resolved = resolveInstalledSlug(slug);
  const targetDir = path.join(skillsBaseDir(), resolved);

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    removeSkillStoreLocks(resolved);
    return { success: true, message: `已卸载 ${resolved}` };
  } catch (err: any) {
    return {
      success: false,
      message: `卸载失败：${err?.message ?? String(err)}`,
    };
  }
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
    return installTencentSkill(slug);
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
  if (resolveSkillStoreBackend() === "tencent-skillhub") {
    return uninstallTencentSkill(slug);
  }

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
