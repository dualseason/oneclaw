import {
  createInitialUpdateBannerState,
  type UpdateBannerState,
} from "./update-banner-state";

let progressCallback: ((percent: number | null) => void) | null = null;
let beforeQuitForInstallCallback: (() => void) | null = null;
let updateBannerStateCallback: ((state: UpdateBannerState) => void) | null = null;
const updateBannerState = createInitialUpdateBannerState();

export function setupAutoUpdater(): void {
  updateBannerStateCallback?.({ ...updateBannerState });
}

export function checkForUpdates(_manual = false): void {
  updateBannerStateCallback?.({ ...updateBannerState });
}

export async function downloadAndInstallUpdate(): Promise<boolean> {
  progressCallback?.(null);
  beforeQuitForInstallCallback?.();
  return false;
}

export function startAutoCheckSchedule(): void {
  // Auto update has been disabled for this build.
}

export function stopAutoCheckSchedule(): void {
  // Auto update has been disabled for this build.
}

export function setProgressCallback(cb: (percent: number | null) => void): void {
  progressCallback = cb;
}

export function setBeforeQuitForInstallCallback(cb: () => void): void {
  beforeQuitForInstallCallback = cb;
}

export function setUpdateBannerStateCallback(cb: (state: UpdateBannerState) => void): void {
  updateBannerStateCallback = cb;
  updateBannerStateCallback({ ...updateBannerState });
}

export function getUpdateBannerState(): UpdateBannerState {
  return { ...updateBannerState };
}
