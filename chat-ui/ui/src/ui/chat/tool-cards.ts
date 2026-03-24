import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({
      kind: "result",
      name,
      text,
      imageCount: countRenderableImages(item),
    });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({
      kind: "result",
      name,
      text,
      imageCount: countRenderableImages(content),
    });
  }

  return cards;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());
  const imageCount = typeof card.imageCount === "number" ? Math.max(0, Math.floor(card.imageCount)) : 0;
  const hasImages = imageCount > 0;
  const isCall = card.kind === "call";
  const statusText = isCall
    ? "Called"
    : hasImages
      ? `${imageCount} image${imageCount === 1 ? "" : "s"}`
      : "Completed";

  const canClick = Boolean(onOpenSidebar) && (hasText || isCall);
  const handleClick = canClick
    ? () => {
        if (isCall) {
          onOpenSidebar!(buildToolCallSidebar(display.label, detail, card.args));
          return;
        }
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*${
          hasImages
            ? `Completed with ${imageCount} image output${imageCount === 1 ? "" : "s"}. View the image${imageCount === 1 ? "" : "s"} in the chat transcript.`
            : "Completed with no text output."
        }*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${
        canClick
          ? (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") {
                return;
              }
              e.preventDefault();
              handleClick?.();
            }
          : nothing
      }
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${canClick ? html`<span class="chat-tool-card__action">View ${icons.check}</span>` : nothing}
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">${icons.check}</span>` : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${
        isEmpty
          ? html`
              <div class="chat-tool-card__status-text muted">${statusText}</div>
            `
          : nothing
      }
      ${
        showCollapsed
          ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
          : nothing
      }
      ${showInline ? html`<div class="chat-tool-card__inline mono">${card.text}</div>` : nothing}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return undefined;
}

function countRenderableImages(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countRenderableImages(item), 0);
  }
  if (typeof value !== "object" || value === null) {
    return 0;
  }

  const item = value as Record<string, unknown>;
  const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
  if (kind === "image") {
    const source = item.source as Record<string, unknown> | undefined;
    if (source?.type === "base64" && typeof source.data === "string" && source.data.trim()) {
      return 1;
    }
    if (typeof item.data === "string" && item.data.trim()) {
      return 1;
    }
    if (typeof item.url === "string" && item.url.trim()) {
      return 1;
    }
  }
  if (kind === "image_url") {
    const imageUrl = item.image_url as Record<string, unknown> | undefined;
    if (typeof imageUrl?.url === "string" && imageUrl.url.trim()) {
      return 1;
    }
  }
  if (Array.isArray(item.content)) {
    return countRenderableImages(item.content);
  }
  return 0;
}

function buildToolCallSidebar(label: string, detail: string | undefined, args: unknown): string {
  const parts = [`## ${label}`];
  if (detail) {
    parts.push(`**Command:** \`${detail}\``);
  }
  if (args !== undefined) {
    const serialized = formatToolArgs(args);
    if (serialized) {
      parts.push("**Arguments**");
      parts.push(`\`\`\`json\n${serialized}\n\`\`\``);
    }
  }
  return parts.join("\n\n");
}

function formatToolArgs(args: unknown): string {
  if (args == null) {
    return "";
  }
  if (typeof args === "string") {
    return args.trim();
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
