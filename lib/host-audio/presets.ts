import { AudioPresets } from "livekit-client";

import type {
  AudioQualityValue,
  HostPresetKey,
  HostStudioSettings,
  MixerChannelSettings,
} from "@/lib/host-audio/types";

type AudioQualityOption = {
  value: AudioQualityValue;
  label: string;
  helper: string;
  preset: (typeof AudioPresets)[keyof typeof AudioPresets];
};

function createChannel(enabled: boolean, gainDb = 0): MixerChannelSettings {
  return {
    enabled,
    gainDb,
    muted: false,
    solo: false,
    channelMode: "stereo",
  };
}

export const AUDIO_QUALITY_OPTIONS: AudioQualityOption[] = [
  {
    value: "data_saver",
    label: "Data saver (24 kbps)",
    helper: "Best for weaker mobile data connections.",
    preset: AudioPresets.speech,
  },
  {
    value: "balanced",
    label: "Balanced (48 kbps)",
    helper: "Recommended for speech, worship music, and most live sessions.",
    preset: AudioPresets.music,
  },
  {
    value: "fuller_sound",
    label: "Fuller sound (64 kbps stereo)",
    helper: "Uses more data for a richer mixer feed.",
    preset: AudioPresets.musicStereo,
  },
];

export function getAudioQualityOption(value: AudioQualityValue) {
  return AUDIO_QUALITY_OPTIONS.find((option) => option.value === value) ?? AUDIO_QUALITY_OPTIONS[1];
}

export function createBaseSettings(): HostStudioSettings {
  return {
    audioQuality: "balanced",
    musicMode: true,
    activePreset: "mixer_feed",
    noiseSuppression: "off",
    compressorPreset: "worship",
    highPassHz: 80,
    gateEnabled: false,
    gateThresholdDb: -48,
    gateReleaseMs: 220,
    masterGainDb: 0,
    headphoneMonitoring: false,
    duckingEnabled: true,
    duckingDepthDb: -12,
    mainDeviceId: "default",
    secondaryDeviceId: "",
    musicLoop: false,
    tabAudioEnabled: false,
    channels: {
      main: createChannel(true, 0),
      secondary: createChannel(false, -2),
      music: createChannel(false, -10),
      system: createChannel(false, -12),
    },
  };
}

export const BUILT_IN_PRESETS: Record<
  HostPresetKey,
  {
    label: string;
    description: string;
    apply: (base?: HostStudioSettings) => HostStudioSettings;
  }
> = {
  laptop_mic: {
    label: "Laptop mic",
    description: "Turns browser voice cleanup on for a built-in laptop microphone.",
    apply: (base = createBaseSettings()) => ({
      ...base,
      activePreset: "laptop_mic",
      musicMode: false,
      noiseSuppression: "rnnoise",
      compressorPreset: "speech",
      highPassHz: 100,
      gateEnabled: true,
      gateThresholdDb: -42,
      channels: {
        ...base.channels,
        main: { ...base.channels.main, enabled: true, gainDb: 2, channelMode: "stereo" },
        secondary: { ...base.channels.secondary, enabled: false },
        music: { ...base.channels.music, enabled: false, gainDb: -16 },
      },
    }),
  },
  mixer_feed: {
    label: "Mixer / Sound desk feed",
    description: "Keeps the path clean for a console or USB mixer feed.",
    apply: (base = createBaseSettings()) => ({
      ...base,
      activePreset: "mixer_feed",
      musicMode: true,
      noiseSuppression: "off",
      compressorPreset: "worship",
      highPassHz: 80,
      gateEnabled: false,
      channels: {
        ...base.channels,
        main: { ...base.channels.main, enabled: true, gainDb: 0, channelMode: "stereo" },
      },
    }),
  },
  podcast_mic: {
    label: "Podcast mic",
    description: "Keeps speech forward and controlled on a dedicated microphone.",
    apply: (base = createBaseSettings()) => ({
      ...base,
      activePreset: "podcast_mic",
      musicMode: false,
      noiseSuppression: "rnnoise",
      compressorPreset: "speech",
      highPassHz: 75,
      gateEnabled: true,
      gateThresholdDb: -46,
      channels: {
        ...base.channels,
        main: { ...base.channels.main, enabled: true, gainDb: 1, channelMode: "stereo" },
        music: { ...base.channels.music, gainDb: -18 },
      },
    }),
  },
  worship_music: {
    label: "Worship music",
    description: "Leaves instruments and singing natural while protecting the stream.",
    apply: (base = createBaseSettings()) => ({
      ...base,
      activePreset: "worship_music",
      musicMode: true,
      noiseSuppression: "off",
      compressorPreset: "worship",
      highPassHz: 60,
      gateEnabled: false,
      channels: {
        ...base.channels,
        main: { ...base.channels.main, enabled: true, gainDb: 0, channelMode: "stereo" },
        music: { ...base.channels.music, enabled: true, gainDb: -8 },
      },
    }),
  },
};

export function buildPreset(key: HostPresetKey, base?: HostStudioSettings) {
  return BUILT_IN_PRESETS[key].apply(base ?? createBaseSettings());
}
