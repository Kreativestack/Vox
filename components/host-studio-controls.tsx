"use client";

import { useMediaDeviceSelect } from "@livekit/components-react";
import {
  ConnectionQuality,
  LocalAudioTrack,
  Room,
  createLocalAudioTrack,
} from "livekit-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import { buildPreset, getAudioQualityOption, AUDIO_QUALITY_OPTIONS, BUILT_IN_PRESETS } from "@/lib/host-audio/presets";
import { VoxAudioMixerProcessor } from "@/lib/host-audio/processor";
import {
  loadCustomPresets,
  loadDeviceSelection,
  loadHostStudioSettings,
  saveCustomPresets,
  saveDeviceSelection,
  saveHostStudioSettings,
} from "@/lib/host-audio/storage";
import type {
  AudioQualityValue,
  HostHealthWarning,
  HostPresetKey,
  HostStudioSettings,
  InputChannelId,
  LoudnessSnapshot,
  MeterSnapshot,
  SavedCustomPreset,
} from "@/lib/host-audio/types";
import type { RoomBroadcastState, VoxEvent } from "@/lib/types";

type HostStudioControlsProps = {
  hasComments: boolean;
  hostPasscode: string;
  listenerCount: number;
  liveElapsedLabel: string | null;
  publishEvent: (event: VoxEvent, reliable: boolean) => Promise<void>;
  room: Room;
  setBroadcastState: (state: RoomBroadcastState) => void;
  setRoomNotice: (message: string | null) => void;
};

type PermissionState = "idle" | "granted" | "denied";

const EMPTY_METER: MeterSnapshot = {
  peak: 0,
  rms: 0,
  truePeak: 0,
  clipped: false,
  clipHoldUntil: 0,
};

const WARNING_COPY: Record<HostHealthWarning, string> = {
  silence: "No speech or music has reached the stream for 20 seconds. Check the input or raise the fader.",
  clipping: "The stream is clipping. Lower the input or master level a little.",
  low_level: "The stream is too quiet. Raise the input gain or move closer to the microphone.",
  device_disconnected: "The selected microphone disconnected. Vox switched back to the system default input.",
  weak_network: "The network looks weak. Keep the host device on strong Wi-Fi or Ethernet if possible.",
};

function buildAudioCaptureOptions(deviceId: string | undefined, musicMode: boolean) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: !musicMode,
    noiseSuppression: !musicMode,
    autoGainControl: !musicMode,
    channelCount: 2,
    sampleRate: 48000,
  };
}

function gainToDb(value: number) {
  if (value <= 0) {
    return -100;
  }

  return 20 * Math.log10(value);
}

function toDbLabel(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`;
}

function meterPercent(value: number) {
  return Math.max(0, Math.min(100, value * 100));
}

function truePeakDb(value: number) {
  if (value <= 0) {
    return "-inf dBTP";
  }

  return `${gainToDb(value).toFixed(1)} dBTP`;
}

function loudnessLabel(value: number | null) {
  if (value == null || Number.isNaN(value)) {
    return "-- LUFS";
  }

  return `${value.toFixed(1)} LUFS`;
}

function loudnessStatus(shortTerm: number | null) {
  if (shortTerm == null || Number.isNaN(shortTerm)) {
    return "Waiting";
  }

  if (shortTerm < -18) {
    return "Too quiet";
  }

  if (shortTerm > -14) {
    return "Too loud";
  }

  return "Good";
}

function normalizeDeviceLabel(device: MediaDeviceInfo, index: number) {
  if (device.deviceId === "default") {
    return `Default system input - ${device.label.replace(/^Default - /i, "")}`;
  }

  if (device.deviceId === "communications") {
    return `Communications input - ${device.label.replace(/^Communications - /i, "")}`;
  }

  return device.label || `Audio input ${index + 1}`;
}

function classifyDevices(devices: MediaDeviceInfo[]) {
  const systemDefaults = devices.filter(
    (device) => device.deviceId === "default" || device.deviceId === "communications",
  );
  const physicalDevices = devices.filter(
    (device) => device.deviceId !== "default" && device.deviceId !== "communications",
  );

  return {
    systemDefaults,
    physicalDevices,
  };
}

function isChromeFamily() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /Chrome|Edg\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
}

function cloneSettings(settings: HostStudioSettings) {
  return JSON.parse(JSON.stringify(settings)) as HostStudioSettings;
}

function loadExternalScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-vox-src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }

      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.voxSrc = src;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(script);
  });
}

export function HostStudioControls({
  hasComments,
  hostPasscode,
  listenerCount,
  liveElapsedLabel,
  publishEvent,
  room,
  setBroadcastState,
  setRoomNotice,
}: HostStudioControlsProps) {
  const initialSettings = useMemo(() => {
    const loaded = loadHostStudioSettings();
    const selection = loadDeviceSelection();
    return {
      ...loaded,
      mainDeviceId: selection.mainDeviceId || loaded.mainDeviceId,
      secondaryDeviceId: selection.secondaryDeviceId || loaded.secondaryDeviceId,
    };
  }, []);
  const [settings, setSettings] = useState<HostStudioSettings>(initialSettings);
  const [customPresets, setCustomPresets] = useState<SavedCustomPreset[]>(() => loadCustomPresets());
  const [isLive, setIsLive] = useState(false);
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioReady, setStudioReady] = useState(false);
  const [permissionState, setPermissionState] = useState<PermissionState>("idle");
  const [permissionHelp, setPermissionHelp] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceWarning, setDeviceWarning] = useState<string | null>(null);
  const [meters, setMeters] = useState<Record<InputChannelId, MeterSnapshot>>({
    main: EMPTY_METER,
    secondary: EMPTY_METER,
    music: EMPTY_METER,
    system: EMPTY_METER,
    master: EMPTY_METER,
  });
  const [loudness, setLoudness] = useState<LoudnessSnapshot>({
    momentary: null,
    shortTerm: null,
    integrated: null,
  });
  const [warnings, setWarnings] = useState<HostHealthWarning[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isDesktopMixerView, setIsDesktopMixerView] = useState(false);
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "ready">("idle");
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingSecondsLeft, setRecordingSecondsLeft] = useState(10);
  const [musicLoadedName, setMusicLoadedName] = useState<string | null>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [speechActive, setSpeechActive] = useState(false);
  const [vadReady, setVadReady] = useState(false);
  const [presetName, setPresetName] = useState("");
  const audioContextRef = useRef<AudioContext | null>(null);
  const trackRef = useRef<LocalAudioTrack | null>(null);
  const processorRef = useRef<VoxAudioMixerProcessor | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const lastSignalAtRef = useRef(Date.now());
  const permissionPromptedRef = useRef(false);
  const deviceSelect = useMediaDeviceSelect({
    kind: "audioinput",
    room,
    requestPermissions: false,
    onError: (error) => {
      setPermissionHelp(error.message);
    },
  });
  const selectedQuality = getAudioQualityOption(settings.audioQuality);
  const { systemDefaults, physicalDevices } = useMemo(() => classifyDevices(devices), [devices]);
  const selectedMainLabel =
    devices.find((device) => device.deviceId === settings.mainDeviceId)?.label ||
    (permissionState === "denied"
      ? "Microphone access blocked"
      : devices.length > 0
        ? "Ready to choose"
        : "Waiting for microphone access");

  useEffect(() => {
    saveHostStudioSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveDeviceSelection({
      mainDeviceId: settings.mainDeviceId,
      secondaryDeviceId: settings.secondaryDeviceId,
    });
  }, [settings.mainDeviceId, settings.secondaryDeviceId]);

  useEffect(() => {
    saveCustomPresets(customPresets);
  }, [customPresets]);

  useEffect(() => {
    if (speechActive || meters.master.rms > 0.02) {
      lastSignalAtRef.current = Date.now();
    }
  }, [meters.master.rms, speechActive]);

  const requestMicrophonePermission = useCallback(async () => {
    if (permissionPromptedRef.current && permissionState === "granted") {
      return true;
    }

    permissionPromptedRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !settings.musicMode,
          noiseSuppression: !settings.musicMode,
          autoGainControl: !settings.musicMode,
          channelCount: 2,
          sampleRate: 48000,
        },
      });
      stream.getTracks().forEach((track) => track.stop());
      setPermissionState("granted");
      setPermissionHelp(null);
      return true;
    } catch {
      setPermissionState("denied");
      setPermissionHelp(
        "Please allow microphone access in the browser address bar, then tap Refresh devices.",
      );
      return false;
    }
  }, [permissionState, settings.mainDeviceId, settings.musicMode]);

  const refreshDevices = useCallback(async () => {
    const permitted =
      permissionState === "granted" ? true : await requestMicrophonePermission();
    const nextDevices = await Room.getLocalDevices("audioinput", permitted);
    setDevices(nextDevices);

    setSettings((current) => {
      const availableMain = nextDevices.some((device) => device.deviceId === current.mainDeviceId);
      const availableSecondary = nextDevices.some(
        (device) => device.deviceId === current.secondaryDeviceId,
      );

      return {
        ...current,
        mainDeviceId: availableMain ? current.mainDeviceId : nextDevices[0]?.deviceId || "default",
        secondaryDeviceId: availableSecondary ? current.secondaryDeviceId : "",
        channels: {
          ...current.channels,
          secondary: {
            ...current.channels.secondary,
            enabled: availableSecondary ? current.channels.secondary.enabled : false,
          },
        },
      };
    });
    return nextDevices;
  }, [permissionState, requestMicrophonePermission]);

  const ensureStudioReady = useCallback(async () => {
    setStudioBusy(true);
    try {
      const hasPermission = await requestMicrophonePermission();
      await refreshDevices();
      if (!hasPermission) {
        return false;
      }

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 48000 });
      }

      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      if (!trackRef.current) {
        trackRef.current = await createLocalAudioTrack(
          buildAudioCaptureOptions(settings.mainDeviceId || "default", settings.musicMode),
        );
        trackRef.current.setAudioContext(audioContextRef.current);
      }

      if (!processorRef.current) {
        const processor = new VoxAudioMixerProcessor(settings);
        processor.setCallbacks({
          onError: (message) => setRoomNotice(message),
          onLoudness: (snapshot) => {
            setLoudness(snapshot);
          },
          onMeter: (channelId, snapshot) => {
            setMeters((current) => ({
              ...current,
              [channelId]: snapshot,
            }));
          },
        });
        processorRef.current = processor;
        await trackRef.current.setProcessor(processor);
      }

      setStudioReady(true);
      return true;
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "The host studio could not start.");
      return false;
    } finally {
      setStudioBusy(false);
    }
  }, [
    refreshDevices,
    requestMicrophonePermission,
    setRoomNotice,
    settings,
  ]);

  useEffect(() => {
    void refreshDevices();

    const onDeviceChange = () => {
      window.setTimeout(() => {
        void refreshDevices().then(async (nextDevices) => {
          if (!nextDevices.some((device) => device.deviceId === settings.mainDeviceId)) {
            setDeviceWarning(WARNING_COPY.device_disconnected);
            setSettings((current) => ({
              ...current,
              mainDeviceId: "default",
            }));
            if (trackRef.current) {
              await trackRef.current.restartTrack(buildAudioCaptureOptions("default", settings.musicMode));
            }
            await room.switchActiveDevice("audioinput", "default");
          }
        });
      }, 400);
    };

    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [devices, refreshDevices, room, settings.mainDeviceId, settings.musicMode]);

  useEffect(() => {
    const updateViewport = () => {
      setIsDesktopMixerView(window.innerWidth >= 960);
    };

    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  useEffect(() => {
    if (!processorRef.current) {
      return;
    }

    void processorRef.current.updateSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!processorRef.current) {
      return;
    }

    processorRef.current.setSpeechActive(speechActive);
  }, [speechActive]);

  useEffect(() => {
    let vad:
      | {
          start?: () => Promise<void>;
          pause?: () => Promise<void>;
          destroy?: () => Promise<void>;
        }
      | null = null;
    let cancelled = false;
    let sourceTrack: MediaStreamTrack | null = null;

    const setupVad = async () => {
      if (!studioReady || !settings.duckingEnabled || !trackRef.current) {
        return;
      }

      try {
        await loadExternalScript("https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js");
        await loadExternalScript(
          "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js",
        );
        const vadModule = (window as typeof window & { vad?: any }).vad;
        if (cancelled) {
          return;
        }
        if (!vadModule?.MicVAD) {
          throw new Error("VAD bundle not available.");
        }

        sourceTrack = trackRef.current.mediaStreamTrack.clone();
        const vadTrack = sourceTrack;
        vad = await vadModule.MicVAD.new({
          startOnLoad: true,
          baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/",
          onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/",
          getStream: async () => new MediaStream([vadTrack]),
          onSpeechStart: () => setSpeechActive(true),
          onSpeechEnd: () => setSpeechActive(false),
          onVADMisfire: () => setSpeechActive(false),
        });
        setVadReady(true);
        if (vad?.start) {
          await vad.start();
        }
      } catch {
        setVadReady(false);
      }
    };

    const cleanupPromise = setupVad();
    return () => {
      cancelled = true;
      setSpeechActive(false);
      setVadReady(false);
      void cleanupPromise;
      sourceTrack?.stop();
      if (vad?.pause) {
        void vad.pause();
      }
      if (vad?.destroy) {
        void vad.destroy();
      }
    };
  }, [settings.duckingEnabled, studioReady]);

  useEffect(() => {
    if (vadReady || !studioReady || !settings.duckingEnabled) {
      return;
    }

    const interval = window.setInterval(() => {
      setSpeechActive(meters.main.rms > 0.035);
    }, 180);

    return () => {
      window.clearInterval(interval);
    };
  }, [meters.main.rms, settings.duckingEnabled, studioReady, vadReady]);

  useEffect(() => {
    if (!studioReady || !processorRef.current) {
      return;
    }

    void processorRef.current.setSecondaryInput(
      settings.secondaryDeviceId,
      settings.channels.secondary.enabled,
      settings.musicMode,
    ).catch((error) => {
      setRoomNotice(error instanceof Error ? error.message : "Secondary input could not start.");
    });
  }, [
    setRoomNotice,
    settings.channels.secondary.enabled,
    settings.musicMode,
    settings.secondaryDeviceId,
    studioReady,
  ]);

  useEffect(() => {
    if (!processorRef.current) {
      return;
    }

    processorRef.current.setMusicLoop(settings.musicLoop);
  }, [settings.musicLoop]);

  useEffect(() => {
    const warningSet = new Set<HostHealthWarning>();
    if (deviceWarning) {
      warningSet.add("device_disconnected");
    }
    if (meters.master.clipped) {
      warningSet.add("clipping");
    }
    if (isLive && loudness.shortTerm != null && loudness.shortTerm < -24) {
      warningSet.add("low_level");
    }
    if (isLive && Date.now() - lastSignalAtRef.current > 20000) {
      warningSet.add("silence");
    }
    if (room.localParticipant.connectionQuality === ConnectionQuality.Poor) {
      warningSet.add("weak_network");
    }
    setWarnings(Array.from(warningSet));
  }, [
    deviceWarning,
    isLive,
    loudness.shortTerm,
    meters.master.clipped,
    room.localParticipant.connectionQuality,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (isLive && Date.now() - lastSignalAtRef.current > 20000) {
        setWarnings((current) =>
          current.includes("silence") ? current : [...current, "silence"],
        );
      }
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [isLive]);

  useEffect(() => {
    const cleanup = async () => {
      if (recordingTimeoutRef.current) {
        window.clearTimeout(recordingTimeoutRef.current);
      }
      mediaRecorderRef.current?.stop();
      if (processorRef.current) {
        await processorRef.current.destroy();
      }
      await trackRef.current?.stopProcessor?.();
      trackRef.current?.stop();
      audioContextRef.current?.close();
      if (recordingUrl) {
        URL.revokeObjectURL(recordingUrl);
      }
    };

    return () => {
      void cleanup();
    };
  }, [recordingUrl]);

  const broadcastStatus = useCallback(
    async (status: "live" | "paused") => {
      await publishEvent(
        {
          type: "status",
          id: crypto.randomUUID(),
          sentAt: Date.now(),
          status,
        },
        true,
      );
    },
    [publishEvent],
  );

  const syncBroadcastState = useCallback(
    async (status: RoomBroadcastState["status"], liveStartedAt: number | null) => {
      const response = await fetch("/api/broadcast-state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          passcode: hostPasscode,
          status,
          liveStartedAt,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        state?: RoomBroadcastState;
      };

      if (!response.ok || !payload.state) {
        throw new Error(payload.error || "Unable to update live timer.");
      }

      setBroadcastState(payload.state);
    },
    [hostPasscode, setBroadcastState],
  );

  const handleToggleLive = useCallback(async () => {
    const ready = await ensureStudioReady();
    if (!ready || !trackRef.current) {
      return;
    }

    setStudioBusy(true);
    setRoomNotice(null);
    try {
      if (isLive) {
        await room.localParticipant.unpublishTrack(trackRef.current, false);
        setIsLive(false);
        await broadcastStatus("paused");
        await syncBroadcastState("paused", null);
      } else {
        const startedAt = Date.now();
        await room.localParticipant.publishTrack(trackRef.current, {
          audioPreset: getAudioQualityOption(settings.audioQuality).preset,
        });
        setIsLive(true);
        await broadcastStatus("live");
        await syncBroadcastState("live", startedAt);
      }
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "Broadcast update failed.");
    } finally {
      setStudioBusy(false);
    }
  }, [
    broadcastStatus,
    ensureStudioReady,
    isLive,
    room.localParticipant,
    setRoomNotice,
    settings.audioQuality,
    syncBroadcastState,
  ]);

  const handleSelectMainDevice = useCallback(
    async (deviceId: string) => {
      setSettings((current) => ({
        ...current,
        mainDeviceId: deviceId,
      }));

      setStudioBusy(true);
      try {
        await ensureStudioReady();
        await deviceSelect.setActiveMediaDevice(deviceId);
        await room.switchActiveDevice("audioinput", deviceId);
        if (trackRef.current && !isLive) {
          await trackRef.current.restartTrack(buildAudioCaptureOptions(deviceId, settings.musicMode));
        }
        setDeviceWarning(null);
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Could not switch input.");
      } finally {
        setStudioBusy(false);
      }
    },
    [deviceSelect, ensureStudioReady, isLive, room, setRoomNotice, settings.musicMode],
  );

  const handleMusicMode = useCallback(async () => {
    const nextMusicMode = !settings.musicMode;
    setSettings((current) => ({
      ...current,
      musicMode: nextMusicMode,
      noiseSuppression: nextMusicMode ? "off" : current.noiseSuppression,
    }));

    if (!trackRef.current) {
      return;
    }

    setStudioBusy(true);
    try {
      await trackRef.current.restartTrack(
        buildAudioCaptureOptions(settings.mainDeviceId || "default", nextMusicMode),
      );
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "Could not update music mode.");
    } finally {
      setStudioBusy(false);
    }
  }, [setRoomNotice, settings.mainDeviceId, settings.musicMode]);

  const handleSelectQuality = useCallback(
    async (quality: AudioQualityValue) => {
      setSettings((current) => ({
        ...current,
        audioQuality: quality,
      }));

      if (!trackRef.current || !isLive) {
        return;
      }

      setStudioBusy(true);
      try {
        await room.localParticipant.unpublishTrack(trackRef.current, false);
        await room.localParticipant.publishTrack(trackRef.current, {
          audioPreset: getAudioQualityOption(quality).preset,
        });
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Could not update audio quality.");
      } finally {
        setStudioBusy(false);
      }
    },
    [isLive, room.localParticipant, setRoomNotice],
  );

  const handleApplyPreset = useCallback((preset: HostPresetKey) => {
    setSettings((current) => {
      const next = buildPreset(preset, cloneSettings(current));
      next.mainDeviceId = current.mainDeviceId;
      next.secondaryDeviceId = current.secondaryDeviceId;
      return next;
    });
  }, []);

  const handleSaveCustomPreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) {
      setRoomNotice("Give the preset a short name first.");
      return;
    }

    const preset: SavedCustomPreset = {
      id: crypto.randomUUID(),
      name,
      settings: cloneSettings(settings),
      createdAt: Date.now(),
    };
    setCustomPresets((current) => [preset, ...current].slice(0, 8));
    setPresetName("");
  }, [presetName, setRoomNotice, settings]);

  const handleMusicFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const ready = await ensureStudioReady();
      if (!ready || !processorRef.current) {
        return;
      }

      try {
        await processorRef.current.loadMusicFile(file);
        setMusicLoadedName(file.name);
        setSettings((current) => ({
          ...current,
          channels: {
            ...current.channels,
            music: {
              ...current.channels.music,
              enabled: true,
            },
          },
        }));
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Music file could not be loaded.");
      } finally {
        event.target.value = "";
      }
    },
    [ensureStudioReady, setRoomNotice],
  );

  const handleMusicTransport = useCallback(
    async (action: "play" | "pause" | "stop") => {
      if (!processorRef.current) {
        return;
      }

      if (action === "play") {
        await processorRef.current.playMusic();
        setMusicPlaying(true);
      } else if (action === "pause") {
        processorRef.current.pauseMusic();
        setMusicPlaying(false);
      } else {
        processorRef.current.stopMusic();
        setMusicPlaying(false);
      }
    },
    [],
  );

  const handleSystemAudio = useCallback(async () => {
    const nextEnabled = !settings.channels.system.enabled;
    const ready = await ensureStudioReady();
    if (!ready || !processorRef.current) {
      return;
    }

    try {
      await processorRef.current.setSystemAudioEnabled(nextEnabled);
      setSettings((current) => ({
        ...current,
        channels: {
          ...current.channels,
          system: {
            ...current.channels.system,
            enabled: nextEnabled,
          },
        },
      }));
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "System audio could not start.");
    }
  }, [ensureStudioReady, setRoomNotice, settings.channels.system.enabled]);

  const handleRecordCheck = useCallback(async () => {
    const ready = await ensureStudioReady();
    if (!ready || !processorRef.current) {
      return;
    }

    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      setRecordingUrl(null);
    }

    const output = processorRef.current.getOutputStream();
    if (!output) {
      setRoomNotice("The processed stream is not ready for a test recording yet.");
      return;
    }

    recordingChunksRef.current = [];
    const recorder = new MediaRecorder(output);
    mediaRecorderRef.current = recorder;
    setRecordingState("recording");
    setRecordingSecondsLeft(10);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordingChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      setRecordingUrl(url);
      setRecordingState("ready");
    };

    recorder.start();
    recordingTimeoutRef.current = window.setTimeout(() => {
      recorder.stop();
    }, 10000);

    const countdown = window.setInterval(() => {
      setRecordingSecondsLeft((seconds) => {
        if (seconds <= 1) {
          window.clearInterval(countdown);
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
  }, [ensureStudioReady, recordingUrl, setRoomNotice]);

  const updateChannel = useCallback(
    (
      channelId: "main" | "secondary" | "music" | "system",
      update: Partial<HostStudioSettings["channels"]["main"]>,
    ) => {
      setSettings((current) => ({
        ...current,
        channels: {
          ...current.channels,
          [channelId]: {
            ...current.channels[channelId],
            ...update,
          },
        },
      }));
    },
    [],
  );

  const handleNoiseSuppression = useCallback((mode: HostStudioSettings["noiseSuppression"]) => {
    setSettings((current) => ({
      ...current,
      noiseSuppression: current.musicMode ? "off" : mode,
    }));
  }, []);

  const soundCheckStatus =
    meters.master.peak > 0.16 && loudnessStatus(loudness.shortTerm) === "Good"
      ? "Good"
      : "Needs a quick check";

  return (
    <section className="vox-host-panel vox-host-panel--studio">
      <div className="vox-host-panel__header">
        <div>
          <h3>Broadcast controls</h3>
          <p className="vox-helper">
            One published track, full host mixer control, and safer device switching while live.
          </p>
        </div>
        <button
          className={isLive ? "vox-button-danger" : "vox-button"}
          disabled={studioBusy}
          type="button"
          onClick={() => void handleToggleLive()}
        >
          {studioBusy ? "Working..." : isLive ? "Pause broadcast" : "Go live"}
        </button>
      </div>

      {(permissionHelp || deviceWarning) && (
        <div className="vox-banner vox-banner--studio" role="status">
          {deviceWarning || permissionHelp}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="vox-host-warnings">
          {warnings.map((warning) => (
            <div key={warning} className="vox-banner vox-banner--studio" role="status">
              {WARNING_COPY[warning]}
            </div>
          ))}
        </div>
      )}

      <div className="vox-host-monitor">
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Status</span>
          <strong className="vox-host-monitor__value">{isLive ? "Live now" : "Standing by"}</strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Input</span>
          <strong className="vox-host-monitor__value" title={selectedMainLabel}>
            {selectedMainLabel}
          </strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Quality</span>
          <strong className="vox-host-monitor__value">{selectedQuality.label}</strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Loudness</span>
          <strong className="vox-host-monitor__value">
            {loudnessStatus(loudness.shortTerm)} ({loudnessLabel(loudness.shortTerm)})
          </strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">True peak</span>
          <strong className="vox-host-monitor__value">{truePeakDb(meters.master.truePeak)}</strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Live timer</span>
          <strong className="vox-host-monitor__value">{liveElapsedLabel ?? "00:00"}</strong>
        </div>
      </div>

      <div className="vox-host-checklist">
        <div className="vox-host-checklist__header">
          <h4>Sound check</h4>
          <span className="vox-helper">
            Select the input, speak into it, aim for green, then do a short playback check.
          </span>
        </div>
        <div className="vox-soundcheck">
          <div className="vox-soundcheck__row">
            <button className="vox-button-secondary" type="button" onClick={() => void ensureStudioReady()}>
              {studioReady ? "Studio ready" : "Enable studio audio"}
            </button>
            <button className="vox-button-secondary" type="button" onClick={() => void handleRecordCheck()}>
              {recordingState === "recording"
                ? `Recording ${recordingSecondsLeft}s`
                : recordingState === "ready"
                  ? "Record again"
                  : "10-second test recording"}
            </button>
          </div>
          <div className="vox-soundcheck__status">
            <span className="vox-pill">{soundCheckStatus}</span>
            <span className="vox-helper">Target: green meter and about -16 LUFS</span>
          </div>
          {recordingUrl && (
            <audio controls className="vox-audio-preview" src={recordingUrl}>
              Your browser does not support audio preview.
            </audio>
          )}
        </div>
      </div>

      <div className="vox-host-panel__grid">
        <label className="vox-label" htmlFor="vox-audio-input">
          Main input
          <select
            id="vox-audio-input"
            className="vox-select"
            value={settings.mainDeviceId}
            onChange={(event) => void handleSelectMainDevice(event.target.value)}
          >
            {systemDefaults.length > 0 && (
              <optgroup label="System defaults">
                {systemDefaults.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {normalizeDeviceLabel(device, index)}
                  </option>
                ))}
              </optgroup>
            )}
            {physicalDevices.length > 0 && (
              <optgroup label="Physical devices">
                {physicalDevices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {normalizeDeviceLabel(device, index)}
                  </option>
                ))}
              </optgroup>
            )}
            {devices.length === 0 && <option value="">No inputs found yet</option>}
          </select>
          <div className="vox-inline-actions">
            <button className="vox-button-secondary" type="button" onClick={() => void refreshDevices()}>
              Refresh devices
            </button>
            <span className="vox-helper">
              Active device: {deviceSelect.activeDeviceId || settings.mainDeviceId || "default"}
            </span>
          </div>
        </label>

        <label className="vox-label" htmlFor="vox-audio-quality">
          Stream quality
          <select
            id="vox-audio-quality"
            className="vox-select"
            value={settings.audioQuality}
            onChange={(event) => void handleSelectQuality(event.target.value as AudioQualityValue)}
          >
            {AUDIO_QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="vox-helper">{selectedQuality.helper}</span>
        </label>

        <label className="vox-toggle">
          <span>
            <strong>Music mode</strong>
            <small>Use this for mixer feeds, instruments, and singing.</small>
          </span>
          <button
            aria-pressed={settings.musicMode}
            className="vox-toggle__switch"
            data-on={settings.musicMode}
            type="button"
            onClick={() => void handleMusicMode()}
          >
            <span />
          </button>
        </label>
      </div>

      <div className="vox-preset-bar">
        {(
          Object.keys(BUILT_IN_PRESETS) as HostPresetKey[]
        ).map((presetKey) => (
          <button
            key={presetKey}
            className="vox-pill vox-pill--preset"
            data-active={settings.activePreset === presetKey}
            type="button"
            onClick={() => handleApplyPreset(presetKey)}
          >
            {BUILT_IN_PRESETS[presetKey].label}
          </button>
        ))}
      </div>

      <div className="vox-inline-actions vox-inline-actions--stackable">
        <input
          className="vox-field"
          placeholder="Save current settings as a custom preset"
          value={presetName}
          onChange={(event) => setPresetName(event.target.value)}
        />
        <button className="vox-button-secondary" type="button" onClick={handleSaveCustomPreset}>
          Save preset
        </button>
      </div>

      {customPresets.length > 0 && (
        <div className="vox-preset-bar">
          {customPresets.map((preset) => (
            <button
              key={preset.id}
              className="vox-pill vox-pill--preset"
              type="button"
              onClick={() => setSettings(cloneSettings(preset.settings))}
            >
              {preset.name}
            </button>
          ))}
        </div>
      )}

      <div className="vox-mixer-header">
        <div>
          <h4>Mixer</h4>
          <p className="vox-helper">Compact strips on desktop, simplified controls on smaller screens.</p>
        </div>
        <button className="vox-button-secondary" type="button" onClick={() => setAdvancedOpen((value) => !value)}>
          {advancedOpen ? "Hide advanced" : "Advanced"}
        </button>
      </div>

      <div className="vox-mixer-grid">
        <ChannelStrip
          channelId="main"
          enabled
          title="Main input"
          subtitle="Primary mic or mixer feed"
          meter={meters.main}
          settings={settings.channels.main}
          onChange={updateChannel}
          showDevice
        />
        {(advancedOpen || isDesktopMixerView) && (
          <>
            <ChannelStrip
              channelId="secondary"
              enabled
              title="Second input"
              subtitle="Optional co-host mic"
              meter={meters.secondary}
              settings={settings.channels.secondary}
              onChange={updateChannel}
              extra={
                <select
                  className="vox-select"
                  value={settings.secondaryDeviceId}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      secondaryDeviceId: event.target.value,
                    }))
                  }
                >
                  <option value="">No second input</option>
                  {physicalDevices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {normalizeDeviceLabel(device, index)}
                    </option>
                  ))}
                </select>
              }
            />
            <ChannelStrip
              channelId="music"
              enabled
              title="Music / media"
              subtitle={musicLoadedName ?? "Play an audio file"}
              meter={meters.music}
              settings={settings.channels.music}
              onChange={updateChannel}
              extra={
                <div className="vox-channel-actions">
                  <input type="file" accept="audio/*" onChange={handleMusicFile} />
                  <div className="vox-inline-actions vox-transport-actions">
                    <button className="vox-button-secondary" type="button" onClick={() => void handleMusicTransport("play")}>
                      Play
                    </button>
                    <button className="vox-button-secondary" type="button" onClick={() => void handleMusicTransport("pause")}>
                      Pause
                    </button>
                    <button className="vox-button-secondary" type="button" onClick={() => void handleMusicTransport("stop")}>
                      Stop
                    </button>
                  </div>
                  <label className="vox-toggle vox-toggle--compact">
                    <span>
                      <strong>Loop</strong>
                      <small>{musicPlaying ? "Playing" : "Stopped"}</small>
                    </span>
                    <button
                      aria-pressed={settings.musicLoop}
                      className="vox-toggle__switch"
                      data-on={settings.musicLoop}
                      type="button"
                      onClick={() =>
                        setSettings((current) => ({
                          ...current,
                          musicLoop: !current.musicLoop,
                        }))
                      }
                    >
                      <span />
                    </button>
                  </label>
                </div>
              }
            />
            {isChromeFamily() && (
              <ChannelStrip
                channelId="system"
                enabled
                title="Tab audio"
                subtitle="Chrome or Edge only"
                meter={meters.system}
                settings={settings.channels.system}
                onChange={updateChannel}
                extra={
                  <button className="vox-button-secondary" type="button" onClick={() => void handleSystemAudio()}>
                    {settings.channels.system.enabled ? "Stop tab audio" : "Add tab audio"}
                  </button>
                }
              />
            )}
          </>
        )}
        <MasterStrip
          loudness={loudness}
          masterGainDb={settings.masterGainDb}
          meter={meters.master}
          onChange={(value) =>
            setSettings((current) => ({
              ...current,
              masterGainDb: value,
            }))
          }
          headphoneMonitoring={settings.headphoneMonitoring}
          onToggleHeadphones={() =>
            setSettings((current) => ({
              ...current,
              headphoneMonitoring: !current.headphoneMonitoring,
            }))
          }
        />
      </div>

      {advancedOpen && (
        <div className="vox-studio-advanced">
          <div className="vox-host-panel__grid">
            <label className="vox-label" htmlFor="vox-noise-suppression">
              Clean up voice
              <select
                id="vox-noise-suppression"
                className="vox-select"
                value={settings.musicMode ? "off" : settings.noiseSuppression}
                onChange={(event) =>
                  handleNoiseSuppression(event.target.value as HostStudioSettings["noiseSuppression"])
                }
                disabled={settings.musicMode}
              >
                <option value="off">Off</option>
                <option value="rnnoise">RNNoise</option>
                <option value="krisp">Krisp (when supported)</option>
              </select>
              <span className="vox-helper">
                Voice cleanup turns off automatically in Music Mode to protect singing and instruments.
              </span>
            </label>

            <label className="vox-label" htmlFor="vox-compressor-preset">
              Compressor
              <select
                id="vox-compressor-preset"
                className="vox-select"
                value={settings.compressorPreset}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    compressorPreset: event.target.value as HostStudioSettings["compressorPreset"],
                  }))
                }
              >
                <option value="speech">Speech</option>
                <option value="worship">Worship / Music</option>
                <option value="off">Off</option>
              </select>
            </label>

            <RangeField
              label="High-pass filter"
              value={settings.highPassHz}
              min={40}
              max={180}
              step={5}
              helper={`${settings.highPassHz} Hz`}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  highPassHz: value,
                }))
              }
            />

            <RangeField
              label="Gate threshold"
              value={settings.gateThresholdDb}
              min={-70}
              max={-20}
              step={1}
              helper={`${settings.gateEnabled ? `${settings.gateThresholdDb} dB` : "Gate off"}`}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  gateThresholdDb: value,
                }))
              }
            />

            <label className="vox-toggle vox-toggle--compact">
              <span>
                <strong>Noise gate</strong>
                <small>Off by default so softer singers are not chopped.</small>
              </span>
              <button
                aria-pressed={settings.gateEnabled}
                className="vox-toggle__switch"
                data-on={settings.gateEnabled}
                type="button"
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    gateEnabled: !current.gateEnabled,
                  }))
                }
              >
                <span />
              </button>
            </label>

            <RangeField
              label="Duck music when speaking"
              value={settings.duckingDepthDb}
              min={-24}
              max={0}
              step={1}
              helper={settings.duckingEnabled ? `${settings.duckingDepthDb} dB` : "Ducking off"}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  duckingDepthDb: value,
                }))
              }
            />

            <label className="vox-toggle vox-toggle--compact">
              <span>
                <strong>Ducking</strong>
                <small>Uses browser VAD first, then falls back to level detection if needed.</small>
              </span>
              <button
                aria-pressed={settings.duckingEnabled}
                className="vox-toggle__switch"
                data-on={settings.duckingEnabled}
                type="button"
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    duckingEnabled: !current.duckingEnabled,
                  }))
                }
              >
                <span />
              </button>
            </label>
          </div>
          <p className="vox-helper">
            Use headphones when monitor mode is on so the host hears exactly what listeners hear without feedback.
          </p>
        </div>
      )}

      <p className="vox-helper">
        {permissionState === "denied"
          ? "Microphone access is blocked right now. Use the browser address bar to allow it, then refresh devices."
          : "Only the host mixer changed here. Listener audio, chat, reactions, and token flow stay the same."}
      </p>
      <p className="vox-helper">
        Quick host check: {devices.length > 0 ? "device ready" : "connect a microphone"},{" "}
        {hasComments ? "chat seen" : "send a test comment"}, and {listenerCount > 0 ? "listener present" : "join once from a listener phone"}.
      </p>
    </section>
  );
}

function ChannelStrip({
  channelId,
  title,
  subtitle,
  meter,
  settings,
  onChange,
  extra,
}: {
  channelId: "main" | "secondary" | "music" | "system";
  enabled: boolean;
  title: string;
  subtitle: string;
  meter: MeterSnapshot;
  settings: HostStudioSettings["channels"]["main"];
  onChange: (
    channelId: "main" | "secondary" | "music" | "system",
    update: Partial<HostStudioSettings["channels"]["main"]>,
  ) => void;
  showDevice?: boolean;
  extra?: ReactNode;
}) {
  return (
    <section className="vox-channel-strip">
      <div className="vox-channel-strip__header">
        <div className="vox-channel-strip__copy">
          <h5>{title}</h5>
          <p className="vox-helper vox-channel-strip__subtitle" title={subtitle}>
            {subtitle}
          </p>
        </div>
        <span className="vox-helper vox-channel-strip__value">{toDbLabel(settings.gainDb)}</span>
      </div>

      <LevelMeter meter={meter} />

      <RangeField
        label="Gain"
        value={settings.gainDb}
        min={-30}
        max={12}
        step={0.5}
        helper={toDbLabel(settings.gainDb)}
        onChange={(value) => onChange(channelId, { gainDb: value })}
      />

      <div className="vox-inline-actions vox-strip-actions">
        <button
          className="vox-button-secondary"
          data-active={settings.muted}
          type="button"
          onClick={() => onChange(channelId, { muted: !settings.muted })}
        >
          {settings.muted ? "Muted" : "Mute"}
        </button>
        <button
          className="vox-button-secondary"
          data-active={settings.solo}
          type="button"
          onClick={() => onChange(channelId, { solo: !settings.solo })}
        >
          {settings.solo ? "Soloed" : "Solo"}
        </button>
      </div>

      <label className="vox-label">
        Channel mode
        <select
          className="vox-select"
          value={settings.channelMode}
          onChange={(event) =>
            onChange(channelId, {
              channelMode: event.target.value as HostStudioSettings["channels"]["main"]["channelMode"],
            })
          }
        >
          <option value="stereo">Stereo</option>
          <option value="left">Left only</option>
          <option value="right">Right only</option>
        </select>
      </label>

      <label className="vox-toggle vox-toggle--compact">
        <span>
          <strong>Channel on</strong>
          <small>{settings.enabled ? "Live in the mix" : "Not in the mix"}</small>
        </span>
        <button
          aria-pressed={settings.enabled}
          className="vox-toggle__switch"
          data-on={settings.enabled}
          type="button"
          onClick={() => onChange(channelId, { enabled: !settings.enabled })}
        >
          <span />
        </button>
      </label>

      {extra}
    </section>
  );
}

function MasterStrip({
  loudness,
  masterGainDb,
  meter,
  onChange,
  headphoneMonitoring,
  onToggleHeadphones,
}: {
  loudness: LoudnessSnapshot;
  masterGainDb: number;
  meter: MeterSnapshot;
  onChange: (value: number) => void;
  headphoneMonitoring: boolean;
  onToggleHeadphones: () => void;
}) {
  return (
    <section className="vox-channel-strip vox-channel-strip--master">
      <div className="vox-channel-strip__header">
        <div className="vox-channel-strip__copy">
          <h5>Master</h5>
          <p className="vox-helper vox-channel-strip__subtitle">Processed stream to listeners</p>
        </div>
        <span className="vox-helper vox-channel-strip__value">{toDbLabel(masterGainDb)}</span>
      </div>

      <LevelMeter meter={meter} />

      <RangeField
        label="Master fader"
        value={masterGainDb}
        min={-18}
        max={12}
        step={0.5}
        helper={toDbLabel(masterGainDb)}
        onChange={onChange}
      />

      <div className="vox-master-stats">
        <div>
          <span className="vox-helper">Momentary</span>
          <strong>{loudnessLabel(loudness.momentary)}</strong>
        </div>
        <div>
          <span className="vox-helper">Short-term</span>
          <strong>{loudnessLabel(loudness.shortTerm)}</strong>
        </div>
        <div>
          <span className="vox-helper">Integrated</span>
          <strong>{loudnessLabel(loudness.integrated)}</strong>
        </div>
      </div>

      <label className="vox-toggle vox-toggle--compact">
        <span>
          <strong>Headphone monitoring</strong>
          <small>{headphoneMonitoring ? "Use headphones to avoid feedback" : "Off by default"}</small>
        </span>
        <button
          aria-pressed={headphoneMonitoring}
          className="vox-toggle__switch"
          data-on={headphoneMonitoring}
          type="button"
          onClick={onToggleHeadphones}
        >
          <span />
        </button>
      </label>
    </section>
  );
}

function LevelMeter({ meter }: { meter: MeterSnapshot }) {
  return (
    <div className="vox-level-meter">
      <div className="vox-level-meter__bar">
        <span className="vox-level-meter__fill" style={{ width: `${meterPercent(meter.rms)}%` }} />
        <span
          className="vox-level-meter__peak"
          style={{ left: `${meterPercent(meter.peak)}%` }}
        />
      </div>
      <div className="vox-inline-actions vox-inline-actions--meter">
        <span className="vox-helper">RMS {toDbLabel(gainToDb(meter.rms))}</span>
        <span className="vox-helper">Peak {truePeakDb(meter.truePeak)}</span>
        <span className={`vox-helper ${meter.clipped ? "vox-text-danger" : ""}`}>
          {meter.clipped ? "Clip" : "Clean"}
        </span>
      </div>
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  helper,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  helper: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="vox-label">
      {label}
      <input
        className="vox-range"
        max={max}
        min={min}
        step={step}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="vox-helper">{helper}</span>
    </label>
  );
}
