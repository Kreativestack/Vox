import { buildPreset, createBaseSettings } from "@/lib/host-audio/presets";
import type { HostSelectionState, HostStudioSettings, SavedCustomPreset } from "@/lib/host-audio/types";

const SETTINGS_KEY = "vox-host-studio-settings";
const CUSTOM_PRESETS_KEY = "vox-host-custom-presets";
const DEVICE_SELECTION_KEY = "vox-host-device-selection";

function isBrowser() {
  return typeof window !== "undefined";
}

export function loadHostStudioSettings() {
  if (!isBrowser()) {
    return buildPreset("mixer_feed");
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return buildPreset("mixer_feed");
    }

    const parsed = JSON.parse(raw) as Partial<HostStudioSettings>;
    return {
      ...createBaseSettings(),
      ...parsed,
      channels: {
        ...createBaseSettings().channels,
        ...(parsed.channels ?? {}),
      },
    } satisfies HostStudioSettings;
  } catch {
    return buildPreset("mixer_feed");
  }
}

export function saveHostStudioSettings(settings: HostStudioSettings) {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadCustomPresets() {
  if (!isBrowser()) {
    return [] as SavedCustomPreset[];
  }

  try {
    const raw = window.localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!raw) {
      return [] as SavedCustomPreset[];
    }

    const parsed = JSON.parse(raw) as SavedCustomPreset[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as SavedCustomPreset[];
  }
}

export function saveCustomPresets(presets: SavedCustomPreset[]) {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}

export function loadDeviceSelection() {
  if (!isBrowser()) {
    return { mainDeviceId: "default", secondaryDeviceId: "" } satisfies HostSelectionState;
  }

  try {
    const raw = window.localStorage.getItem(DEVICE_SELECTION_KEY);
    if (!raw) {
      return { mainDeviceId: "default", secondaryDeviceId: "" } satisfies HostSelectionState;
    }

    const parsed = JSON.parse(raw) as Partial<HostSelectionState>;
    return {
      mainDeviceId: typeof parsed.mainDeviceId === "string" ? parsed.mainDeviceId : "default",
      secondaryDeviceId:
        typeof parsed.secondaryDeviceId === "string" ? parsed.secondaryDeviceId : "",
    } satisfies HostSelectionState;
  } catch {
    return { mainDeviceId: "default", secondaryDeviceId: "" } satisfies HostSelectionState;
  }
}

export function saveDeviceSelection(selection: HostSelectionState) {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.setItem(DEVICE_SELECTION_KEY, JSON.stringify(selection));
}
