import { html, nothing } from "lit";
import { t } from "./i18n.ts";

export type SkillItem = {
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

export type SkillDetailItem = SkillItem & {
  readme: string;
  tags: string[];
};

export type SkillStoreState = {
  skills: SkillItem[];
  installedSlugs: Set<string>;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  sort: "updated" | "trending" | "downloads";
  nextCursor: string | null;
  installingSlugs: Set<string>;
  toastMessage: string | null;
  detailSlug: string | null;
  detailData: SkillDetailItem | null;
  detailLoading: boolean;
  detailError: string | null;
};

export type SkillStoreCallbacks = {
  onInstall: (slug: string) => void;
  onUninstall: (slug: string) => void;
  onOpenDetail: (slug: string) => void;
  onCloseDetail: () => void;
  onCopySlug: (slug: string) => void;
};

const AVATAR_COLORS = [
  "#c0392b", "#d35400", "#e67e22", "#f39c12",
  "#27ae60", "#1abc9c", "#16a085", "#2980b9",
  "#3498db", "#8e44ad", "#9b59b6", "#34495e",
];

function avatarColor(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) - hash + slug.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatDownloads(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

function renderSkillCard(
  skill: SkillItem,
  installed: boolean,
  installing: boolean,
  selected: boolean,
  onOpenDetail: () => void,
  onInstall: () => void,
  onUninstall: () => void,
) {
  const letter = (skill.name || skill.slug || "?").charAt(0).toUpperCase();
  const bgColor = avatarColor(skill.slug);

  return html`
    <div class="skill-store__card ${selected ? "skill-store__card--active" : ""}">
      <div class="skill-store__card-header">
        <div class="skill-store__card-icon" style="background: ${bgColor}; color: #fff;">
          <span class="skill-store__card-letter">${letter}</span>
        </div>
        <div class="skill-store__card-info">
          <div class="skill-store__card-name">${skill.name}</div>
          <div class="skill-store__card-meta">
            ${skill.version ? html`v${skill.version}` : nothing}
            ${skill.downloads > 0
              ? html`
                  <span class="skill-store__card-downloads">
                    ${formatDownloads(skill.downloads)} ${t("skillStore.downloads")}
                  </span>
                `
              : nothing}
          </div>
        </div>
        <div class="skill-store__card-action">
          <button
            class="skill-store__btn skill-store__btn--ghost"
            type="button"
            @click=${onOpenDetail}
          >${t("skillStore.view")}</button>
          ${installed
            ? html`
                <button
                  class="skill-store__btn skill-store__btn--installed"
                  type="button"
                  @click=${onUninstall}
                  ?disabled=${installing}
                >${t("skillStore.uninstall")}</button>
              `
            : html`
                <button
                  class="skill-store__btn skill-store__btn--install"
                  type="button"
                  @click=${onInstall}
                  ?disabled=${installing}
                >${installing ? t("skillStore.installing") : t("skillStore.install")}</button>
              `}
        </div>
      </div>
      <div class="skill-store__card-desc">${skill.description}</div>
    </div>
  `;
}

function sortSkills(skills: SkillItem[], installedSlugs: Set<string>): SkillItem[] {
  return [...skills].sort((a, b) => {
    const ai = installedSlugs.has(a.slug) ? 0 : 1;
    const bi = installedSlugs.has(b.slug) ? 0 : 1;
    return ai - bi;
  });
}

function resolveDetailSkill(state: SkillStoreState): SkillItem | SkillDetailItem | null {
  if (!state.detailSlug) {
    return null;
  }
  if (state.detailData?.slug === state.detailSlug) {
    return state.detailData;
  }
  return state.skills.find((skill) => skill.slug === state.detailSlug) ?? null;
}

function renderDetailModal(state: SkillStoreState, callbacks: SkillStoreCallbacks) {
  const skill = resolveDetailSkill(state);
  if (!skill) {
    return nothing;
  }

  const detail = state.detailData?.slug === skill.slug ? state.detailData : null;
  const tags = Array.isArray(detail?.tags) ? detail.tags : [];
  const installed = state.installedSlugs.has(skill.slug);
  const installing = state.installingSlugs.has(skill.slug);

  return html`
    <div class="skill-store__modal-backdrop" @click=${callbacks.onCloseDetail}>
      <section
        class="skill-store__modal"
        role="dialog"
        aria-modal="true"
        aria-label=${t("skillStore.details")}
        @click=${(event: Event) => event.stopPropagation()}
      >
        <div class="skill-store__modal-header">
          <div>
            <div class="skill-store__modal-title">${skill.name}</div>
            <div class="skill-store__modal-subtitle">${skill.slug}</div>
          </div>
          <button
            class="skill-store__icon-btn"
            type="button"
            @click=${callbacks.onCloseDetail}
            aria-label=${t("skillStore.close")}
          >×</button>
        </div>

        <div class="skill-store__modal-body">
          ${skill.description
            ? html`<p class="skill-store__modal-desc">${skill.description}</p>`
            : nothing}

          <div class="skill-store__detail-grid">
            <div class="skill-store__detail-item">
              <span class="skill-store__detail-label">${t("skillStore.version")}</span>
              <span class="skill-store__detail-value">${skill.version || "-"}</span>
            </div>
            <div class="skill-store__detail-item">
              <span class="skill-store__detail-label">${t("skillStore.downloads")}</span>
              <span class="skill-store__detail-value">${formatDownloads(skill.downloads || 0)}</span>
            </div>
            <div class="skill-store__detail-item">
              <span class="skill-store__detail-label">${t("skillStore.author")}</span>
              <span class="skill-store__detail-value">${skill.author || "-"}</span>
            </div>
            <div class="skill-store__detail-item">
              <span class="skill-store__detail-label">${t("skillStore.status")}</span>
              <span class="skill-store__detail-value">
                ${installed ? t("skillStore.installed") : t("skillStore.notInstalled")}
              </span>
            </div>
          </div>

          ${state.detailLoading
            ? html`<div class="skill-store__detail-loading">${t("chat.loading")}</div>`
            : nothing}

          ${state.detailError
            ? html`<div class="skill-store__detail-error">${state.detailError}</div>`
            : nothing}

          ${tags.length > 0
            ? html`
                <div class="skill-store__detail-section">
                  <div class="skill-store__detail-section-title">${t("skillStore.tags")}</div>
                  <div class="skill-store__tag-list">
                    ${tags.map((tag) => html`<span class="skill-store__tag">${tag}</span>`)}
                  </div>
                </div>
              `
            : nothing}

          ${detail?.readme
            ? html`
                <div class="skill-store__detail-section">
                  <div class="skill-store__detail-section-title">${t("skillStore.details")}</div>
                  <div class="skill-store__detail-readme">${detail.readme}</div>
                </div>
              `
            : nothing}
        </div>

        <div class="skill-store__modal-actions">
          <button
            class="skill-store__btn skill-store__btn--ghost"
            type="button"
            @click=${() => callbacks.onCopySlug(skill.slug)}
          >${t("skillStore.copySlug")}</button>
          ${installed
            ? html`
                <button
                  class="skill-store__btn skill-store__btn--installed"
                  type="button"
                  ?disabled=${installing}
                  @click=${() => callbacks.onUninstall(skill.slug)}
                >${t("skillStore.uninstall")}</button>
              `
            : html`
                <button
                  class="skill-store__btn skill-store__btn--install"
                  type="button"
                  ?disabled=${installing}
                  @click=${() => callbacks.onInstall(skill.slug)}
                >${installing ? t("skillStore.installing") : t("skillStore.install")}</button>
              `}
        </div>
      </section>
    </div>
  `;
}

export function renderSkillStoreView(
  state: SkillStoreState,
  callbacks: SkillStoreCallbacks,
) {
  const sorted = sortSkills(state.skills, state.installedSlugs);

  return html`
    ${state.error
      ? html`<div class="skill-store__error">${state.error}</div>`
      : nothing}

    ${sorted.length === 0 && !state.loading && !state.error
      ? html`<div class="skill-store__empty">${t("skillStore.empty")}</div>`
      : nothing}

    <div class="skill-store__list">
      ${sorted.map((skill) =>
        renderSkillCard(
          skill,
          state.installedSlugs.has(skill.slug),
          state.installingSlugs.has(skill.slug),
          state.detailSlug === skill.slug,
          () => callbacks.onOpenDetail(skill.slug),
          () => callbacks.onInstall(skill.slug),
          () => callbacks.onUninstall(skill.slug),
        ),
      )}
    </div>

    ${state.loading
      ? html`<div class="skill-store__loading">${t("chat.loading")}</div>`
      : nothing}

    ${state.toastMessage
      ? html`<div class="skill-store__toast">${state.toastMessage}</div>`
      : nothing}

    ${renderDetailModal(state, callbacks)}
  `;
}
