import { ipcMain } from "electron";
import {
  readUserConfig,
  verifyProvider,
  writeUserConfig,
} from "./provider-config";
import {
  loadSettingsModelConfig,
  normalizeModelRole,
  saveSettingsModelProvider,
} from "./settings-model-routes";
import type * as analytics from "./analytics";

type SettingsActionResult = {
  success: boolean;
  message?: string;
};

type RunTrackedSettingsAction = <T extends SettingsActionResult>(
  action: analytics.SettingsAction,
  props: Record<string, unknown>,
  run: () => Promise<T>,
) => Promise<T>;

interface RegisterSettingsModelIpcDeps {
  runTrackedSettingsAction: RunTrackedSettingsAction;
  writeUserConfigAndRestart: typeof writeUserConfig;
}

export function registerSettingsModelIpc(
  deps: RegisterSettingsModelIpcDeps,
): void {
  const { runTrackedSettingsAction, writeUserConfigAndRestart } = deps;

  ipcMain.handle("settings:get-config", async () => {
    try {
      const { config, migrated, modelRoles } = loadSettingsModelConfig();
      if (migrated) {
        writeUserConfig(config);
      }
      return {
        success: true,
        data: {
          ...modelRoles.thinking,
          modelRoles,
        },
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("settings:verify-key", async (_event, params) => {
    const provider = typeof params?.provider === "string" ? params.provider : "";
    return runTrackedSettingsAction("verify_key", { provider }, async () =>
      verifyProvider(params),
    );
  });

  ipcMain.handle("settings:save-provider", async (_event, params) => {
    const { provider, apiKey, modelID, baseURL, api, subPlatform, supportImage, customPreset } =
      params;
    const role = normalizeModelRole(params?.role);
    const trackedProps = {
      role,
      provider,
      model: modelID,
      sub_platform: subPlatform || undefined,
      custom_preset: customPreset || undefined,
    };

    return runTrackedSettingsAction("save_provider", trackedProps, async () => {
      try {
        const config = readUserConfig();
        saveSettingsModelProvider(config, {
          role,
          provider,
          apiKey,
          modelID,
          baseURL,
          api,
          subPlatform,
          supportImage,
          customPreset,
        });
        writeUserConfigAndRestart(config);
        return { success: true };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    });
  });
}
