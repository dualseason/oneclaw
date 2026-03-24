"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_IMAGE_MODEL_PROVIDER = "clawimage";
const DEFAULT_IMAGE_MODEL_ID = "gemini-3.0-pro-image-2k";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "low";
const REQUEST_TIMEOUT_MS = 90000;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pushUnique(target, value) {
  if (!value || target.includes(value)) return;
  target.push(value);
}

function readUserConfig() {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

function readConfiguredImageRoute(config) {
  const sidecarPath = path.join(os.homedir(), ".openclaw", "oneclaw.config.json");
  let routeFromOneclaw = "";
  try {
    const sidecarRaw = fs.readFileSync(sidecarPath, "utf-8");
    const sidecar = JSON.parse(sidecarRaw);
    routeFromOneclaw = sidecar?.modelRoutes?.image?.route;
  } catch {}
  if (typeof routeFromOneclaw === "string" && routeFromOneclaw.trim()) {
    return routeFromOneclaw.trim();
  }
  const imageModel = config?.agents?.defaults?.imageModel;
  if (typeof imageModel === "string") return imageModel.trim();
  if (imageModel && typeof imageModel === "object") return trimString(imageModel.primary);
  return "";
}

function splitModelRoute(route) {
  const raw = trimString(route);
  if (!raw) return { providerKey: "", modelId: "" };
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0) return { providerKey: "", modelId: raw };
  return {
    providerKey: raw.slice(0, slashIndex).trim(),
    modelId: raw.slice(slashIndex + 1).trim(),
  };
}

function extractConfiguredModelIds(provider) {
  if (!Array.isArray(provider?.models)) return [];
  const out = [];
  for (const item of provider.models) {
    if (typeof item === "string") {
      pushUnique(out, item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      pushUnique(out, trimString(item.id));
    }
  }
  return out;
}

function normalizeContentType(value) {
  return trimString(value).split(";")[0]?.trim().toLowerCase() || "";
}

function formatHttpError(status, text) {
  const parsed = tryParseJson(text);
  const message = trimString(parsed?.error?.message) || trimString(parsed?.message);
  if (message) return `HTTP ${status}: ${message}`;
  const body = String(text || "").trim();
  if (!body) return `HTTP ${status}`;
  return `HTTP ${status}: ${body.slice(0, 280)}`;
}

function tryParseJson(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function toBase64DataUrl(base64, mimeType) {
  return `data:${mimeType};base64,${String(base64).replace(/\s+/g, "")}`;
}

function looksLikeBase64(value) {
  const trimmed = String(value || "").replace(/\s+/g, "");
  return trimmed.length > 64 && trimmed.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(trimmed);
}

function mimeTypeFromDataUrl(value) {
  const match = /^data:(image\/[^;,]+)[;,]/i.exec(String(value || ""));
  return match?.[1]?.toLowerCase() ?? null;
}

function detectImageMimeTypeFromBuffer(buffer) {
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
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
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

function parseImageDataUrl(value) {
  const match = /^data:(image\/[^;,]+);base64,(.+)$/i.exec(String(value || "").trim());
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    data: match[2].replace(/\s+/g, ""),
  };
}

function normalizeMimeType(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("image/")) return trimmed;
  if (trimmed === "png" || trimmed === "jpeg" || trimmed === "jpg" || trimmed === "webp") {
    return `image/${trimmed === "jpg" ? "jpeg" : trimmed}`;
  }
  return null;
}

function normalizeImageUrl(value, mimeType) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return { url: trimmed, mimeType: mimeTypeFromDataUrl(trimmed) || mimeType };
  }
  if (looksLikeBase64(trimmed)) {
    const resolvedMime = mimeType || "image/png";
    return { url: toBase64DataUrl(trimmed, resolvedMime), mimeType: resolvedMime };
  }
  return null;
}

function extractImageFromUnknown(payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    const markdownMatch = /!\[[^\]]*]\(([^)\s]+)[^)]*\)/.exec(payload);
    if (markdownMatch?.[1]) return normalizeImageUrl(markdownMatch[1], null);
    return normalizeImageUrl(payload, null);
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const extracted = extractImageFromUnknown(item);
      if (extracted) return extracted;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  const record = payload;
  const directUrl =
    normalizeImageUrl(record.url, normalizeMimeType(record.mimeType)) ||
    normalizeImageUrl(record.image_url, normalizeMimeType(record.mimeType)) ||
    normalizeImageUrl(record.image_url?.url, normalizeMimeType(record.mimeType));
  if (directUrl) return directUrl;
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
  const nestedKeys = ["data", "output", "choices", "content", "images", "message"];
  for (const key of nestedKeys) {
    const extracted = extractImageFromUnknown(record[key]);
    if (extracted) return extracted;
  }
  return null;
}

function buildRequestHeaders(provider, apiKey) {
  const headers = new Headers();
  const rawHeaders = provider?.headers;
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string" && key.trim()) headers.set(key, value);
    }
  }
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (provider?.authHeader === false) return headers;
  const authMode = trimString(provider?.auth).toLowerCase();
  if (authMode === "api-key") {
    headers.set("x-api-key", apiKey);
    return headers;
  }
  headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

async function getJson(url, headers, endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      endpoint,
      contentType,
      json: tryParseJson(text),
      text,
      dataUrl: null,
      errorMessage: response.ok ? "" : formatHttpError(response.status, text || response.statusText),
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

async function postJson(url, headers, endpoint, body) {
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
        errorMessage: response.ok ? "" : formatHttpError(response.status, parsed.text || raw || response.statusText),
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
    return {
      ok: response.ok,
      status: response.status,
      endpoint,
      contentType,
      json: tryParseJson(text),
      text,
      dataUrl: null,
      errorMessage: response.ok ? "" : formatHttpError(response.status, text || response.statusText),
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

function extractImageFromHttpResult(result) {
  if (!result.ok) return null;
  if (result.dataUrl) return { url: result.dataUrl, mimeType: result.contentType || "image/png" };
  return extractImageFromUnknown(result.json) || extractImageFromUnknown(result.text);
}

async function ensureExtractedImageDataUrl(image) {
  if (!/^https?:\/\//i.test(image.url)) return image;
  const fetched = await fetchRemoteImageAsDataUrl(image.url, image.mimeType);
  return fetched || image;
}

async function fetchRemoteImageAsDataUrl(url, mimeType) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "image/*,*/*;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return null;
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

function parseSsePayload(raw) {
  const chunks = [];
  const textParts = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = tryParseJson(payload);
    if (!parsed) continue;
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

function scoreModelCandidate(model, configuredModel) {
  if (model === configuredModel) return -100;
  const normalized = model.toLowerCase();
  if (normalized.includes("image-preview")) return 0;
  if (normalized.includes("pro-image")) return 1;
  if (normalized.includes("image")) return 2;
  return 20;
}

function pushScoredModel(target, model, score) {
  const normalized = trimString(model);
  if (!normalized) return;
  const previous = target.get(normalized);
  if (previous == null || score < previous) target.set(normalized, score);
}

async function resolveImageProviderContext() {
  const config = readUserConfig();
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") throw new Error("No model providers are configured.");
  const configuredRoute = readConfiguredImageRoute(config);
  const { providerKey: routeProviderKey, modelId: routeModelId } = splitModelRoute(configuredRoute);
  const providerKey =
    routeProviderKey ||
    (providers[DEFAULT_IMAGE_MODEL_PROVIDER] ? DEFAULT_IMAGE_MODEL_PROVIDER : Object.keys(providers)[0] || "");
  if (!providerKey) throw new Error("No image provider is configured.");
  const provider = providers[providerKey];
  if (!provider || typeof provider !== "object") throw new Error(`Configured image provider is missing: ${providerKey}`);
  const baseUrl = trimString(provider.baseUrl);
  const apiKey = trimString(provider.apiKey);
  if (!baseUrl) throw new Error(`Image provider ${providerKey} is missing Base URL.`);
  if (!apiKey) throw new Error(`Image provider ${providerKey} is missing API key.`);
  const configuredModels = extractConfiguredModelIds(provider);
  const configuredModel = routeModelId || configuredModels[0] || DEFAULT_IMAGE_MODEL_ID;
  return {
    providerKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiType: trimString(provider.api) || "openai-completions",
    headers: buildRequestHeaders(provider, apiKey),
    configuredModel,
    configuredModels,
  };
}

async function loadRemoteModelCandidates(provider) {
  const result = await getJson(`${provider.baseUrl}/models`, provider.headers, "/models");
  if (!result.ok || !Array.isArray(result.json?.data)) return [];
  const out = [];
  for (const item of result.json.data) {
    if (item && typeof item === "object") pushUnique(out, trimString(item.id));
  }
  return out;
}

async function resolveModelCandidates(provider) {
  const ordered = new Map();
  pushScoredModel(ordered, provider.configuredModel, -100);
  for (const model of provider.configuredModels) {
    pushScoredModel(ordered, model, scoreModelCandidate(model, provider.configuredModel));
  }
  for (const model of await loadRemoteModelCandidates(provider)) {
    pushScoredModel(ordered, model, scoreModelCandidate(model, provider.configuredModel));
  }
  return Array.from(ordered.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([model]) => model)
    .slice(0, 5);
}

function buildAttemptPlan(apiType, model, prompt, size, quality) {
  const chatMessages = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ];
  const chatAttempts = [
    {
      endpoint: "/chat/completions",
      body: {
        model,
        messages: [{ role: "user", content: prompt }],
        modalities: ["text", "image"],
        max_tokens: 512,
        stream: true,
      },
    },
    {
      endpoint: "/chat/completions",
      body: { model, messages: chatMessages, modalities: ["text", "image"], max_tokens: 512, stream: false },
    },
    {
      endpoint: "/chat/completions",
      body: { model, messages: chatMessages, max_tokens: 512, stream: false },
    },
    {
      endpoint: "/chat/completions",
      body: { model, messages: [{ role: "user", content: prompt }], max_tokens: 512, stream: false },
    },
  ];
  const imageAttempts = [
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
        tools: [{ type: "image_generation", model, size, quality, output_format: "png" }],
        store: false,
        max_output_tokens: 512,
      },
    },
  ];
  if (apiType === "openai-responses") return [imageAttempts[1], imageAttempts[0], ...chatAttempts];
  return [...chatAttempts, ...imageAttempts];
}

function selectPrimaryFailureMessage(configuredModel, attempts) {
  const configuredAttempt = attempts.find((attempt) => attempt.model === configuredModel && attempt.message);
  if (configuredAttempt?.message) return configuredAttempt.message;
  return attempts.find((attempt) => attempt.message)?.message || "";
}

async function generateImage(params) {
  const prompt = trimString(params?.prompt);
  if (!prompt) {
    return { success: false, message: "Image prompt is required.", attempts: [] };
  }

  let provider;
  try {
    provider = await resolveImageProviderContext();
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error), attempts: [] };
  }

  const size = trimString(params?.size) || DEFAULT_SIZE;
  const quality = trimString(params?.quality).toLowerCase() || DEFAULT_QUALITY;
  const attempts = [];

  for (const model of await resolveModelCandidates(provider)) {
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

  return {
    success: false,
    message:
      selectPrimaryFailureMessage(provider.configuredModel, attempts) ||
      "The configured image provider did not return a usable image.",
    attempts,
  };
}

function toToolResponse(result) {
  if (!result.success) {
    const attempts = Array.isArray(result.attempts) ? result.attempts.slice(0, 5) : [];
    const attemptText = attempts.length
      ? `\n\nAttempts:\n${attempts
          .map((attempt) => `- ${attempt.model} ${attempt.endpoint} ${attempt.status ?? "ERR"}: ${attempt.message}`)
          .join("\n")}`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `Image generation failed: ${result.message}${attemptText}`,
        },
      ],
      details: {
        success: false,
        message: result.message,
        attempts: result.attempts,
      },
    };
  }

  const response = {
    content: [
      {
        type: "text",
        text: result.data.revisedPrompt
          ? `Generated image with ${result.data.model}.\nRevised prompt: ${result.data.revisedPrompt}`
          : `Generated image with ${result.data.model}.`,
      },
    ],
    details: {
      success: true,
      provider: result.data.provider,
      model: result.data.model,
      endpoint: result.data.endpoint,
      mimeType: result.data.mimeType,
      revisedPrompt: result.data.revisedPrompt,
    },
  };
  const imagePayload = parseImageDataUrl(result.data.url);
  if (!imagePayload) {
    return {
      content: [
        {
          type: "text",
          text:
            "Image generation failed: provider returned an image output that could not be normalized for in-app display.",
        },
      ],
      details: {
        success: false,
        message: "Provider returned an image output that could not be normalized for in-app display.",
        provider: result.data.provider,
        model: result.data.model,
        endpoint: result.data.endpoint,
        mimeType: result.data.mimeType,
      },
    };
  }
  response.content.push({
    type: "image",
    data: imagePayload.data,
    mimeType: imagePayload.mimeType,
  });
  return response;
}

const parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: {
      type: "string",
      description: "Detailed prompt describing the image to generate.",
    },
    size: {
      type: "string",
      enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
      default: "1024x1024",
      description: "Optional output size.",
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high", "auto"],
      default: "low",
      description: "Optional quality level.",
    },
  },
  required: ["prompt"],
};

const plugin = {
  id: "oneclaw-image-generation",
  name: "Wanboshan Image Generation",
  description: "Generate images with the configured clawimage provider.",
  configSchema: {
    parse(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    },
    uiHints: {},
  },
  register(api) {
    api.registerTool({
      name: "oneclaw_generate_image",
      label: "Wanboshan Image",
      description:
        "Generate an image from a text prompt using the configured clawimage provider. Use this when the user explicitly asks to create or render an image, illustration, icon, poster, wallpaper, logo, cover, or other visual asset.",
      parameters,
      async execute(_toolCallId, params) {
        const result = await generateImage(params ?? {});
        if (!result.success) {
          api.logger.warn(`[wanboshan-image-generation] ${result.message}`);
        }
        return toToolResponse(result);
      },
    });
  },
};

module.exports = plugin;
module.exports.default = plugin;
