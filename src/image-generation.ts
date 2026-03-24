import { readUserConfig } from "./provider-config";
import { readUserConfigModelRoute } from "./model-routes";
import * as log from "./logger";

type AttemptFailure = {
  model: string;
  endpoint: string;
  status: number | null;
  message: string;
};

export type GenerateImageParams = {
  prompt: string;
  size?: string;
  quality?: string;
};

export type GenerateImageResult =
  | {
      success: true;
      data: {
        url: string;
        mimeType: string | null;
        provider: string;
        model: string;
        endpoint: string;
        prompt: string;
        revisedPrompt?: string;
      };
    }
  | {
      success: false;
      message: string;
      attempts: AttemptFailure[];
    };

type ProviderContext = {
  providerKey: string;
  baseUrl: string;
  apiType: string;
  headers: Headers;
  configuredModel: string;
  configuredModels: string[];
};

type HttpResult = {
  ok: boolean;
  status: number | null;
  endpoint: string;
  contentType: string;
  json: any | null;
  text: string;
  dataUrl: string | null;
  errorMessage: string;
};

type ExtractedImage = {
  url: string;
  mimeType: string | null;
  revisedPrompt?: string;
};

type AttemptSpec = {
  endpoint: string;
  body: Record<string, unknown>;
};

const DEFAULT_IMAGE_MODEL_PROVIDER = "clawimage";
const DEFAULT_IMAGE_MODEL_ID = "gemini-3.0-pro-image-2k";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "low";
const REQUEST_TIMEOUT_MS = 90_000;

export async function generateImageWithConfiguredProvider(
  params: GenerateImageParams,
): Promise<GenerateImageResult> {
  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) {
    return {
      success: false,
      message: "Image prompt is required.",
      attempts: [],
    };
  }

  let provider: ProviderContext;
  try {
    provider = await resolveImageProviderContext();
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      attempts: [],
    };
  }

  const size = normalizeSize(params.size);
  const quality = normalizeQuality(params.quality);
  const attempts: AttemptFailure[] = [];
  const modelCandidates = await resolveModelCandidates(provider);

  for (const model of modelCandidates) {
    for (const spec of buildAttemptPlan(provider.apiType, model, prompt, size, quality)) {
      const result = await postJson(
        `${provider.baseUrl}${spec.endpoint}`,
        provider.headers,
        spec.endpoint,
        spec.body,
      );

      const extracted = extractImageFromHttpResult(result);
      if (result.ok && extracted) {
        const normalizedImage = await ensureExtractedImageDataUrl(extracted);
        if (!/^https?:\/\//i.test(normalizedImage.url)) {
          log.info(
            `[image-generation] success provider=${provider.providerKey} model=${model} endpoint=${spec.endpoint}`,
          );
          return {
            success: true,
            data: {
              url: normalizedImage.url,
              mimeType: normalizedImage.mimeType,
              provider: provider.providerKey,
              model,
              endpoint: spec.endpoint,
              prompt,
              revisedPrompt: normalizedImage.revisedPrompt,
            },
          };
        }
      }

      attempts.push({
        model,
        endpoint: spec.endpoint,
        status: result.status,
        message: result.ok
          ? extracted
            ? "Provider returned a remote image URL that could not be normalized."
            : "Provider returned no displayable image payload."
          : result.errorMessage,
      });
    }
  }

  const lastFailure = attempts[attempts.length - 1];
  if (lastFailure) {
    log.warn(
      `[image-generation] failed provider=${provider.providerKey} configuredModel=${provider.configuredModel} last=${lastFailure.model} ${lastFailure.endpoint} ${lastFailure.status ?? "ERR"} ${lastFailure.message}`,
    );
  }

  return {
    success: false,
    message:
      selectPrimaryFailureMessage(provider.configuredModel, attempts) ||
      "The configured image provider did not return a usable image.",
    attempts,
  };
}

async function resolveImageProviderContext(): Promise<ProviderContext> {
  const config = readUserConfig();
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") {
    throw new Error("No model providers are configured.");
  }

  const configuredRoute = readConfiguredImageRoute(config);
  const { providerKey: routeProviderKey, modelId: routeModelId } = splitModelRoute(configuredRoute);
  const fallbackProviderKey =
    routeProviderKey ||
    (providers[DEFAULT_IMAGE_MODEL_PROVIDER] ? DEFAULT_IMAGE_MODEL_PROVIDER : "");
  const providerKey = fallbackProviderKey || firstObjectKey(providers);
  if (!providerKey) {
    throw new Error("No image provider is configured.");
  }

  const provider = providers[providerKey];
  if (!provider || typeof provider !== "object") {
    throw new Error(`Configured image provider is missing: ${providerKey}`);
  }

  const baseUrl = trimString((provider as any).baseUrl);
  const apiKey = trimString((provider as any).apiKey);
  if (!baseUrl) {
    throw new Error(`Image provider ${providerKey} is missing Base URL.`);
  }
  if (!apiKey) {
    throw new Error(`Image provider ${providerKey} is missing API key.`);
  }

  const configuredModels = extractConfiguredModelIds((provider as any));
  const configuredModel = routeModelId || configuredModels[0] || DEFAULT_IMAGE_MODEL_ID;

  return {
    providerKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiType: trimString((provider as any).api) || "openai-completions",
    headers: buildRequestHeaders(provider as any, apiKey),
    configuredModel,
    configuredModels,
  };
}

function readConfiguredImageRoute(config: any): string {
  const routeConfig = readUserConfigModelRoute(config, "image");
  if (typeof routeConfig?.route === "string" && routeConfig.route.trim()) {
    return routeConfig.route.trim();
  }
  const imageModel = config?.agents?.defaults?.imageModel;
  if (typeof imageModel === "string") {
    return imageModel.trim();
  }
  if (imageModel && typeof imageModel === "object") {
    return trimString((imageModel as any).primary);
  }
  return "";
}

function splitModelRoute(route: string): { providerKey: string; modelId: string } {
  const raw = trimString(route);
  if (!raw) {
    return { providerKey: "", modelId: "" };
  }
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0) {
    return { providerKey: "", modelId: raw };
  }
  return {
    providerKey: raw.slice(0, slashIndex).trim(),
    modelId: raw.slice(slashIndex + 1).trim(),
  };
}

function extractConfiguredModelIds(provider: any): string[] {
  if (!Array.isArray(provider?.models)) {
    return [];
  }
  const out: string[] = [];
  for (const item of provider.models) {
    if (typeof item === "string") {
      pushUnique(out, item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      pushUnique(out, trimString((item as any).id));
    }
  }
  return out;
}

function buildRequestHeaders(provider: any, apiKey: string): Headers {
  const headers = new Headers();
  const rawHeaders = provider?.headers;
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string" && key.trim()) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (provider?.authHeader === false) {
    return headers;
  }

  const authMode = trimString(provider?.auth).toLowerCase();
  if (authMode === "api-key") {
    headers.set("x-api-key", apiKey);
    return headers;
  }

  headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

async function resolveModelCandidates(provider: ProviderContext): Promise<string[]> {
  const ordered = new Map<string, number>();
  pushScoredModel(ordered, provider.configuredModel, -100);
  for (const model of provider.configuredModels) {
    pushScoredModel(ordered, model, scoreModelCandidate(model, provider.configuredModel));
  }

  const liveModels = await loadRemoteModelCandidates(provider);
  for (const model of liveModels) {
    pushScoredModel(ordered, model, scoreModelCandidate(model, provider.configuredModel));
  }

  return Array.from(ordered.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([model]) => model)
    .slice(0, 5);
}

async function loadRemoteModelCandidates(provider: ProviderContext): Promise<string[]> {
  const result = await getJson(`${provider.baseUrl}/models`, provider.headers, "/models");
  if (!result.ok || !Array.isArray(result.json?.data)) {
    return [];
  }
  const out: string[] = [];
  for (const item of result.json.data) {
    if (item && typeof item === "object") {
      pushUnique(out, trimString((item as any).id));
    }
  }
  return out;
}

function scoreModelCandidate(model: string, configuredModel: string): number {
  if (model === configuredModel) {
    return -100;
  }
  const normalized = model.toLowerCase();
  if (normalized.includes("image-preview")) {
    return 0;
  }
  if (normalized.includes("pro-image")) {
    return 1;
  }
  if (normalized.includes("image")) {
    return 2;
  }
  return 20;
}

function pushScoredModel(target: Map<string, number>, model: string, score: number): void {
  const normalized = trimString(model);
  if (!normalized) {
    return;
  }
  const previous = target.get(normalized);
  if (previous == null || score < previous) {
    target.set(normalized, score);
  }
}

function buildAttemptPlan(
  apiType: string,
  model: string,
  prompt: string,
  size: string,
  quality: string,
): AttemptSpec[] {
  const chatMessages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt,
        },
      ],
    },
  ];

  const chatAttempts: AttemptSpec[] = [
    {
      endpoint: "/chat/completions",
      body: {
        model,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        modalities: ["text", "image"],
        max_tokens: 512,
        stream: true,
      },
    },
    {
      endpoint: "/chat/completions",
      body: {
        model,
        messages: chatMessages,
        modalities: ["text", "image"],
        max_tokens: 512,
        stream: false,
      },
    },
    {
      endpoint: "/chat/completions",
      body: {
        model,
        messages: chatMessages,
        max_tokens: 512,
        stream: false,
      },
    },
    {
      endpoint: "/chat/completions",
      body: {
        model,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 512,
        stream: false,
      },
    },
  ];

  const imageAttempts: AttemptSpec[] = [
    {
      endpoint: "/images/generations",
      body: {
        model,
        prompt,
        size,
        quality,
        output_format: "png",
        response_format: "b64_json",
      },
    },
    {
      endpoint: "/responses",
      body: {
        model,
        input: prompt,
        tools: [
          {
            type: "image_generation",
            model,
            size,
            quality,
            output_format: "png",
          },
        ],
        store: false,
        max_output_tokens: 512,
      },
    },
  ];

  if (apiType === "openai-responses") {
    return [imageAttempts[1], imageAttempts[0], ...chatAttempts];
  }
  return [...chatAttempts, ...imageAttempts];
}

async function getJson(url: string, headers: Headers, endpoint: string): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const text = await response.text();
    const json = tryParseJson(text);
    return {
      ok: response.ok,
      status: response.status,
      endpoint,
      contentType,
      json,
      text,
      dataUrl: null,
      errorMessage: response.ok
        ? ""
        : formatHttpError(response.status, text || response.statusText),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      endpoint,
      contentType: "",
      json: null,
      text: "",
      dataUrl: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  url: string,
  headers: Headers,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (contentType.startsWith("text/event-stream")) {
      const raw = await response.text();
      const parsed = parseSsePayload(raw);
      return {
        ok: response.ok,
        status: response.status,
        endpoint,
        contentType,
        json: parsed.json,
        text: parsed.text,
        dataUrl: null,
        errorMessage: response.ok
          ? ""
          : formatHttpError(response.status, parsed.text || raw || response.statusText),
      };
    }
    if (contentType.startsWith("image/")) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        ok: response.ok,
        status: response.status,
        endpoint,
        contentType,
        json: null,
        text: "",
        dataUrl: toDataUrl(buffer, contentType),
        errorMessage: response.ok ? "" : formatHttpError(response.status, response.statusText),
      };
    }

    const text = await response.text();
    const json = tryParseJson(text);
    return {
      ok: response.ok,
      status: response.status,
      endpoint,
      contentType,
      json,
      text,
      dataUrl: null,
      errorMessage: response.ok
        ? ""
        : formatHttpError(response.status, text || response.statusText),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      endpoint,
      contentType: "",
      json: null,
      text: "",
      dataUrl: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractImageFromHttpResult(result: HttpResult): ExtractedImage | null {
  if (!result.ok) {
    return null;
  }
  if (result.dataUrl) {
    return {
      url: result.dataUrl,
      mimeType: result.contentType || "image/png",
    };
  }
  return extractImageFromUnknown(result.json) ?? extractImageFromUnknown(result.text);
}

async function ensureExtractedImageDataUrl(image: ExtractedImage): Promise<ExtractedImage> {
  if (!/^https?:\/\//i.test(image.url)) {
    return image;
  }

  const fetched = await fetchRemoteImageAsDataUrl(image.url, image.mimeType);
  return fetched ?? image;
}

async function fetchRemoteImageAsDataUrl(
  url: string,
  mimeType: string | null,
): Promise<ExtractedImage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "image/*,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      return null;
    }
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const resolvedMimeType =
      detectImageMimeTypeFromBuffer(buffer) ||
      (contentType.startsWith("image/") ? contentType : "") ||
      mimeType ||
      "image/png";

    return {
      url: toDataUrl(buffer, resolvedMimeType),
      mimeType: resolvedMimeType,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseSsePayload(raw: string): { json: Record<string, unknown> | null; text: string } {
  const chunks: any[] = [];
  const textParts: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    const parsed = tryParseJson(payload);
    if (!parsed) {
      continue;
    }
    chunks.push(parsed);

    const delta = parsed?.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content.trim()) {
      textParts.push(delta.content);
      continue;
    }

    if (Array.isArray(delta?.content)) {
      for (const item of delta.content) {
        if (item && typeof item === "object" && typeof item.text === "string" && item.text.trim()) {
          textParts.push(item.text);
        }
      }
    }
  }

  return {
    json: chunks.length > 0 ? { chunks, text: textParts.join("") } : null,
    text: textParts.join(""),
  };
}

function extractImageFromUnknown(payload: unknown): ExtractedImage | null {
  if (!payload) {
    return null;
  }

  if (typeof payload === "string") {
    const markdownMatch = /!\[[^\]]*]\(([^)\s]+)[^)]*\)/.exec(payload);
    if (markdownMatch?.[1]) {
      return normalizeImageUrl(markdownMatch[1], null);
    }
    return normalizeImageUrl(payload, null);
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const extracted = extractImageFromUnknown(item);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  if (typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;

  const directUrl =
    normalizeImageUrl(record.url, normalizeMimeType(record.mimeType)) ??
    normalizeImageUrl(record.image_url, normalizeMimeType(record.mimeType)) ??
    normalizeImageUrl((record.image_url as any)?.url, normalizeMimeType(record.mimeType));
  if (directUrl) {
    return directUrl;
  }

  if (typeof record.b64_json === "string") {
    return {
      url: toBase64DataUrl(record.b64_json, normalizeMimeType(record.output_format) || "image/png"),
      mimeType: normalizeMimeType(record.output_format) || "image/png",
      revisedPrompt: trimString(record.revised_prompt),
    };
  }

  if (typeof record.result === "string" && looksLikeBase64(record.result)) {
    return {
      url: toBase64DataUrl(record.result, normalizeMimeType(record.output_format) || "image/png"),
      mimeType: normalizeMimeType(record.output_format) || "image/png",
      revisedPrompt: trimString(record.revised_prompt),
    };
  }

  if (record.source && typeof record.source === "object") {
    const source = record.source as Record<string, unknown>;
    if (typeof source.data === "string" && looksLikeBase64(source.data)) {
      const mimeType = trimString(source.media_type) || normalizeMimeType(record.mimeType) || "image/png";
      return {
        url: toBase64DataUrl(source.data, mimeType),
        mimeType,
      };
    }
  }

  const nestedKeys = ["data", "output", "choices", "content", "images", "message"];
  for (const key of nestedKeys) {
    const extracted = extractImageFromUnknown(record[key]);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function normalizeImageUrl(value: unknown, mimeType: string | null): ExtractedImage | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return {
      url: trimmed,
      mimeType: mimeTypeFromDataUrl(trimmed) || mimeType,
    };
  }
  if (looksLikeBase64(trimmed)) {
    const resolvedMime = mimeType || "image/png";
    return {
      url: toBase64DataUrl(trimmed, resolvedMime),
      mimeType: resolvedMime,
    };
  }
  return null;
}

function normalizeSize(size: string | undefined): string {
  const value = trimString(size);
  return value || DEFAULT_SIZE;
}

function normalizeQuality(quality: string | undefined): string {
  const value = trimString(quality).toLowerCase();
  return value || DEFAULT_QUALITY;
}

function normalizeMimeType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("image/")) {
    return trimmed;
  }
  if (trimmed === "png" || trimmed === "jpeg" || trimmed === "jpg" || trimmed === "webp") {
    return `image/${trimmed === "jpg" ? "jpeg" : trimmed}`;
  }
  return null;
}

function normalizeContentType(value: string | null): string {
  return trimString(value).split(";")[0]?.trim().toLowerCase() || "";
}

function toBase64DataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64.replace(/\s+/g, "")}`;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function looksLikeBase64(value: string): boolean {
  const trimmed = value.replace(/\s+/g, "");
  return trimmed.length > 64 && trimmed.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(trimmed);
}

function mimeTypeFromDataUrl(value: string): string | null {
  const match = /^data:(image\/[^;,]+)[;,]/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

function detectImageMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function tryParseJson(text: string): any | null {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatHttpError(status: number, text: string): string {
  const parsed = tryParseJson(text);
  const message =
    trimString(parsed?.error?.message) ||
    trimString(parsed?.message);
  if (message) {
    return `HTTP ${status}: ${message}`;
  }
  const body = text.trim();
  if (!body) {
    return `HTTP ${status}`;
  }
  return `HTTP ${status}: ${body.slice(0, 280)}`;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pushUnique(target: string[], value: string): void {
  if (!value || target.includes(value)) {
    return;
  }
  target.push(value);
}

function firstObjectKey(input: Record<string, unknown>): string {
  for (const key of Object.keys(input)) {
    if (key.trim()) {
      return key;
    }
  }
  return "";
}

function selectPrimaryFailureMessage(
  configuredModel: string,
  attempts: AttemptFailure[],
): string {
  const configuredAttempt = attempts.find(
    (attempt) => attempt.model === configuredModel && attempt.message,
  );
  if (configuredAttempt?.message) {
    return configuredAttempt.message;
  }
  return attempts.find((attempt) => attempt.message)?.message || "";
}
