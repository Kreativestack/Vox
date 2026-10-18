export type InputChannelId = "main" | "secondary" | "music" | "system" | "master";

export type AudioQualityValue = "data_saver" | "balanced" | "fuller_sound";

export type ChannelMode = "stereo" | "left" | "right";

export type NoiseSuppressionMode = "off" | "rnnoise" | "krisp";

export type CompressorPreset = "speech" | "worship" | "off";

export type HostPresetKey =
  | "laptop_mic"
  | "mixer_feed"
  | "podcast_mic"
  | "worship_music";

export type MeterSnapshot = {
  peak: number;
  rms: number;
  truePeak: number;
  clipped: boolean;
  clipHoldUntil: number;
};

export type LoudnessSnapshot = {
  momentary: number | null;
  shortTerm: number | null;
  integrated: number | null;
};

export type HostHealthWarning =
  | "silence"
  | "clipping"
  | "low_level"
  | "device_disconnected"
  | "weak_network";

export type MixerChannelSettings = {
  enabled: boolean;
  gainDb: number;
  muted: boolean;
  solo: boolean;
  channelMode: ChannelMode;
};

export type HostStudioSettings = {
  audioQuality: AudioQualityValue;
  musicMode: boolean;
  activePreset: HostPresetKey;
  noiseSuppression: NoiseSuppressionMode;
  compressorPreset: CompressorPreset;
  highPassHz: number;
  gateEnabled: boolean;
  gateThresholdDb: number;
  gateReleaseMs: number;
  masterGainDb: number;
  headphoneMonitoring: boolean;
  duckingEnabled: boolean;
  duckingDepthDb: number;
  mainDeviceId: string;
  secondaryDeviceId: string;
  musicLoop: boolean;
  tabAudioEnabled: boolean;
  channels: Record<"main" | "secondary" | "music" | "system", MixerChannelSettings>;
};

export type HostSelectionState = {
  mainDeviceId: string;
  secondaryDeviceId: string;
};

export type SavedCustomPreset = {
  id: string;
  name: string;
  settings: HostStudioSettings;
  createdAt: number;
};
