import type { SkillStatusEntry, SkillStatusReport } from "./types.ts";

function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgent = String(navigator.userAgent ?? "").toLowerCase();
  const platform = String(navigator.platform ?? "").toLowerCase();
  return userAgent.includes("windows") || platform.startsWith("win");
}

function normalizeSkillIdentity(skill: SkillStatusEntry): string {
  const name = typeof skill.name === "string" ? skill.name.trim() : "";
  const skillKey = typeof skill.skillKey === "string" ? skill.skillKey.trim() : "";
  return (name || skillKey).toLowerCase();
}

export function filterHiddenSkillStatusReport(
  report: SkillStatusReport | null | undefined,
): SkillStatusReport | null | undefined {
  if (!report || !Array.isArray(report.skills) || !isWindowsPlatform()) {
    return report;
  }

  const filteredSkills = report.skills.filter((skill) => normalizeSkillIdentity(skill) !== "tmux");
  if (filteredSkills.length === report.skills.length) {
    return report;
  }

  return {
    ...report,
    skills: filteredSkills,
  };
}
