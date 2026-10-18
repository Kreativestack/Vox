import { Track, type AudioProcessorOptions, type TrackProcessor } from "livekit-client";

import type {
  HostStudioSettings,
  InputChannelId,
  LoudnessSnapshot,
  MeterSnapshot,
} from "@/lib/host-audio/types";

type MeterCallback = (channelId: InputChannelId, snapshot: MeterSnapshot) => void;
type LoudnessCallback = (snapshot: LoudnessSnapshot) => void;
type ErrorCallback = (message: string) => void;

type ChannelNodes = {
  source?: AudioNode;
  splitter?: ChannelSplitterNode;
  merger?: ChannelMergerNode;
  trim: GainNode;
  hp: BiquadFilterNode;
  gate?: AudioWorkletNode;
  compressor?: DynamicsCompressorNode;
  state: GainNode;
  duck?: GainNode;
  meter: AudioWorkletNode;
};

type RuntimeKrispProcessor = {
  processedTrack?: MediaStreamTrack;
  init: (opts: AudioProcessorOptions) => Promise<void>;
  restart: (opts: AudioProcessorOptions) => Promise<void>;
  destroy: () => Promise<void>;
};

type RuntimeRnnoiseNode = AudioWorkletNode & {
  destroy: () => void;
};

const BASE_WORKLET_PATHS = [
  "/audio-worklets/vox-meter-worklet.js",
  "/audio-worklets/vox-limiter-worklet.js",
  "/audio-worklets/vox-gate-worklet.js",
  "/audio-worklets/vox-loudness-worklet.js",
];

const workletLoaders = new WeakMap<AudioContext, Promise<void>>();
const rnnoiseLoaders = new WeakMap<AudioContext, Promise<ArrayBuffer>>();

function dbToGain(value: number) {
  return Math.pow(10, value / 20);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeMeter(data: Record<string, unknown>): MeterSnapshot {
  return {
    peak: typeof data.peak === "number" ? data.peak : 0,
    rms: typeof data.rms === "number" ? data.rms : 0,
    truePeak: typeof data.truePeak === "number" ? data.truePeak : 0,
    clipped: Boolean(data.clipped),
    clipHoldUntil: typeof data.clipHoldUntil === "number" ? data.clipHoldUntil : 0,
  };
}

async function ensureBaseWorklets(context: AudioContext) {
  const existing = workletLoaders.get(context);
  if (existing) {
    await existing;
    return;
  }

  const promise = Promise.all(BASE_WORKLET_PATHS.map((path) => context.audioWorklet.addModule(path))).then(
    () => undefined,
  );
  workletLoaders.set(context, promise);
  await promise;
}

async function ensureRnnoise(
  context: AudioContext,
  loadRnnoise: (options: { url: string; simdUrl: string }) => Promise<ArrayBuffer>,
) {
  const existing = rnnoiseLoaders.get(context);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    await context.audioWorklet.addModule("/vendor/rnnoise/rnnoise-worklet.js");
    return loadRnnoise({
      url: "/vendor/rnnoise/rnnoise.wasm",
      simdUrl: "/vendor/rnnoise/rnnoise_simd.wasm",
    });
  })();

  rnnoiseLoaders.set(context, promise);
  return promise;
}

export class VoxAudioMixerProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  readonly name = "vox-host-mixer";

  processedTrack?: MediaStreamTrack;

  private context?: AudioContext;
  private settings: HostStudioSettings;
  private mainTrack?: MediaStreamTrack;
  private destination?: MediaStreamAudioDestinationNode;
  private masterInput?: GainNode;
  private masterGain?: GainNode;
  private limiter?: AudioWorkletNode;
  private masterMeter?: AudioWorkletNode;
  private loudnessMeter?: AudioWorkletNode;
  private headphoneTap?: GainNode;
  private mainSourceNode?: MediaStreamAudioSourceNode;
  private mainSourceStream?: MediaStream;
  private mainKrisp?: RuntimeKrispProcessor;
  private mainRnnoise?: RuntimeRnnoiseNode;
  private mainRnnoiseBypass?: GainNode;
  private secondStream?: MediaStream;
  private secondSourceNode?: MediaStreamAudioSourceNode;
  private secondSourceStream?: MediaStream;
  private systemStream?: MediaStream;
  private systemSourceNode?: MediaStreamAudioSourceNode;
  private systemSourceStream?: MediaStream;
  private musicElement?: HTMLAudioElement;
  private musicSourceNode?: MediaElementAudioSourceNode;
  private musicUrl?: string;
  private currentOutputStream?: MediaStream;
  private speaking = false;
  private channelNodes: Partial<Record<"main" | "secondary" | "music" | "system", ChannelNodes>> = {};
  private meterCallback?: MeterCallback;
  private loudnessCallback?: LoudnessCallback;
  private errorCallback?: ErrorCallback;
  private loudnessSnapshot: LoudnessSnapshot = {
    momentary: null,
    shortTerm: null,
    integrated: null,
  };

  constructor(settings: HostStudioSettings) {
    this.settings = settings;
  }

  setCallbacks(callbacks: {
    onMeter?: MeterCallback;
    onLoudness?: LoudnessCallback;
    onError?: ErrorCallback;
  }) {
    this.meterCallback = callbacks.onMeter;
    this.loudnessCallback = callbacks.onLoudness;
    this.errorCallback = callbacks.onError;
  }

  getOutputStream() {
    return this.currentOutputStream;
  }

  getMainTrack() {
    return this.mainTrack;
  }

  private async loadKrispModule() {
    const runtimeImport = new Function(
      'return import("@livekit/krisp-noise-filter")',
    ) as () => Promise<{
      KrispNoiseFilter: () => RuntimeKrispProcessor;
      isKrispNoiseFilterSupported: () => boolean;
    }>;
    return runtimeImport();
  }

  private async loadRnnoiseModule() {
    const runtimeImport = new Function(
      'return import("@sapphi-red/web-noise-suppressor")',
    ) as () => Promise<{
      RnnoiseWorkletNode: new (
        context: AudioContext,
        options: { maxChannels: number; wasmBinary: ArrayBuffer },
      ) => RuntimeRnnoiseNode;
      loadRnnoise: (options: { url: string; simdUrl: string }) => Promise<ArrayBuffer>;
    }>;
    return runtimeImport();
  }

  async init(opts: AudioProcessorOptions) {
    this.context = opts.audioContext;
    this.mainTrack = opts.track;

    await ensureBaseWorklets(this.context);
    await this.buildGraph();
    await this.attachMainTrack(opts);
    this.applySettings(this.settings);
  }

  async restart(opts: AudioProcessorOptions) {
    this.mainTrack = opts.track;
    await this.attachMainTrack(opts);
    this.applySettings(this.settings);
  }

  async destroy() {
    this.mainSourceNode?.disconnect();
    this.secondSourceNode?.disconnect();
    this.systemSourceNode?.disconnect();
    this.musicSourceNode?.disconnect();
    Object.values(this.channelNodes).forEach((channel) => {
      channel?.source?.disconnect();
      channel?.splitter?.disconnect();
      channel?.merger?.disconnect();
      channel?.trim.disconnect();
      channel?.hp.disconnect();
      channel?.gate?.disconnect();
      channel?.compressor?.disconnect();
      channel?.state.disconnect();
      channel?.duck?.disconnect();
      channel?.meter.disconnect();
    });
    this.masterInput?.disconnect();
    this.masterGain?.disconnect();
    this.limiter?.disconnect();
    this.masterMeter?.disconnect();
    this.loudnessMeter?.disconnect();
    this.headphoneTap?.disconnect();
    this.mainKrisp && (await this.mainKrisp.destroy());
    this.mainRnnoise?.destroy();
    this.secondStream?.getTracks().forEach((track) => track.stop());
    this.systemStream?.getTracks().forEach((track) => track.stop());
    this.musicElement?.pause();
    if (this.musicUrl) {
      URL.revokeObjectURL(this.musicUrl);
      this.musicUrl = undefined;
    }
  }

  async updateSettings(settings: HostStudioSettings) {
    this.settings = settings;
    if (!this.context) {
      return;
    }

    if (this.settings.musicMode && this.settings.noiseSuppression !== "off") {
      this.settings = {
        ...this.settings,
        noiseSuppression: "off",
      };
    }

    await this.rebuildMainProcessing();
    if (this.secondSourceNode) {
      this.connectSourceToChannel("secondary", this.secondSourceNode, true);
    }
    if (this.musicSourceNode) {
      this.connectSourceToChannel("music", this.musicSourceNode, false);
    }
    if (this.systemSourceNode) {
      this.connectSourceToChannel("system", this.systemSourceNode, false);
    }
    this.applySettings(this.settings);
  }

  setSpeechActive(active: boolean) {
    this.speaking = active;
    this.applyStateGains();
  }

  async setSecondaryInput(deviceId: string, enabled: boolean, musicMode: boolean) {
    this.settings = {
      ...this.settings,
      secondaryDeviceId: deviceId,
      channels: {
        ...this.settings.channels,
        secondary: {
          ...this.settings.channels.secondary,
          enabled,
        },
      },
    };

    this.secondSourceNode?.disconnect();
    this.secondStream?.getTracks().forEach((track) => track.stop());
    this.secondStream = undefined;
    this.secondSourceNode = undefined;
    this.secondSourceStream = undefined;

    if (!this.context || !enabled || !deviceId) {
      this.applyStateGains();
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: !musicMode,
        noiseSuppression: !musicMode,
        autoGainControl: !musicMode,
        sampleRate: 48000,
        channelCount: 2,
      },
    });

    this.secondStream = stream;
    this.secondSourceStream = new MediaStream([stream.getAudioTracks()[0]]);
    this.secondSourceNode = this.context.createMediaStreamSource(this.secondSourceStream);
    this.connectSourceToChannel("secondary", this.secondSourceNode, true);
    this.applySettings(this.settings);
  }

  async setSystemAudioEnabled(enabled: boolean) {
    this.settings = {
      ...this.settings,
      tabAudioEnabled: enabled,
      channels: {
        ...this.settings.channels,
        system: {
          ...this.settings.channels.system,
          enabled,
        },
      },
    };

    this.systemSourceNode?.disconnect();
    this.systemStream?.getTracks().forEach((track) => track.stop());
    this.systemStream = undefined;
    this.systemSourceNode = undefined;
    this.systemSourceStream = undefined;

    if (!this.context || !enabled) {
      this.applyStateGains();
      return;
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    const audioTrack = displayStream.getAudioTracks()[0];
    if (!audioTrack) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error("System or tab audio is not available from this share window.");
    }

    displayStream.getVideoTracks().forEach((track) => track.stop());
    this.systemStream = new MediaStream([audioTrack]);
    this.systemSourceStream = new MediaStream([audioTrack]);
    this.systemSourceNode = this.context.createMediaStreamSource(this.systemSourceStream);
    this.connectSourceToChannel("system", this.systemSourceNode, false);
    this.applySettings(this.settings);
  }

  async loadMusicFile(file: File | null) {
    if (!this.context || !file) {
      return;
    }

    if (!this.musicElement) {
      this.musicElement = new Audio();
      this.musicElement.crossOrigin = "anonymous";
      this.musicElement.preload = "auto";
      this.musicSourceNode = this.context.createMediaElementSource(this.musicElement);
      this.connectSourceToChannel("music", this.musicSourceNode, false);
    }

    if (this.musicUrl) {
      URL.revokeObjectURL(this.musicUrl);
    }

    this.musicUrl = URL.createObjectURL(file);
    this.musicElement.src = this.musicUrl;
    this.musicElement.loop = this.settings.musicLoop;
    this.settings = {
      ...this.settings,
      channels: {
        ...this.settings.channels,
        music: {
          ...this.settings.channels.music,
          enabled: true,
        },
      },
    };
    this.applySettings(this.settings);
  }

  setMusicLoop(loop: boolean) {
    this.settings = { ...this.settings, musicLoop: loop };
    if (this.musicElement) {
      this.musicElement.loop = loop;
    }
  }

  async playMusic(fadeMs = 600) {
    if (!this.musicElement || !this.context) {
      return;
    }

    await this.context.resume();
    this.musicElement.loop = this.settings.musicLoop;
    this.musicElement.volume = 1;
    await this.musicElement.play();
    const node = this.channelNodes.music;
    if (node) {
      node.state.gain.cancelScheduledValues(this.context.currentTime);
      node.state.gain.setValueAtTime(0.0001, this.context.currentTime);
      node.state.gain.linearRampToValueAtTime(1, this.context.currentTime + fadeMs / 1000);
    }
  }

  pauseMusic() {
    if (!this.musicElement || !this.context) {
      return;
    }

    const element = this.musicElement;
    const node = this.channelNodes.music;
    if (!node) {
      element.pause();
      return;
    }

    const now = this.context.currentTime;
    node.state.gain.cancelScheduledValues(now);
    node.state.gain.setTargetAtTime(0.0001, now, 0.08);
    window.setTimeout(() => {
      element.pause();
      this.applyStateGains();
    }, 220);
  }

  stopMusic() {
    if (!this.musicElement) {
      return;
    }

    this.musicElement.pause();
    this.musicElement.currentTime = 0;
    this.applyStateGains();
  }

  private async buildGraph() {
    if (!this.context) {
      return;
    }

    this.destination = this.context.createMediaStreamDestination();
    this.currentOutputStream = this.destination.stream;
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    this.masterInput = this.context.createGain();
    this.masterGain = this.context.createGain();
    this.headphoneTap = this.context.createGain();
    this.headphoneTap.gain.value = 0;
    this.limiter = new AudioWorkletNode(this.context, "vox-limiter-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        lookaheadMs: 5,
        ceilingDb: -1,
      },
    });
    this.masterMeter = new AudioWorkletNode(this.context, "vox-meter-processor");
    this.loudnessMeter = new AudioWorkletNode(this.context, "vox-loudness-processor");

    this.masterMeter.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      this.meterCallback?.("master", normalizeMeter(event.data));
    };
    this.loudnessMeter.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      this.loudnessSnapshot = {
        momentary: typeof event.data.momentary === "number" ? event.data.momentary : null,
        shortTerm: typeof event.data.shortTerm === "number" ? event.data.shortTerm : null,
        integrated: typeof event.data.integrated === "number" ? event.data.integrated : null,
      };
      this.loudnessCallback?.(this.loudnessSnapshot);
    };

    this.masterInput.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.destination);
    this.limiter.connect(this.masterMeter);
    this.limiter.connect(this.loudnessMeter);
    this.limiter.connect(this.headphoneTap);
    this.headphoneTap.connect(this.context.destination);

    this.channelNodes.main = this.createChannel("main");
    this.channelNodes.secondary = this.createChannel("secondary");
    this.channelNodes.music = this.createChannel("music");
    this.channelNodes.system = this.createChannel("system");
  }

  private createChannel(channelId: "main" | "secondary" | "music" | "system") {
    if (!this.context || !this.masterInput) {
      throw new Error("Audio context is not ready yet.");
    }

    const trim = this.context.createGain();
    const hp = this.context.createBiquadFilter();
    hp.type = "highpass";
    const state = this.context.createGain();
    const duck = this.context.createGain();
    const meter = new AudioWorkletNode(this.context, "vox-meter-processor");
    meter.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      this.meterCallback?.(channelId, normalizeMeter(event.data));
    };

    state.connect(duck);
    duck.connect(meter);
    meter.connect(this.masterInput);

    return {
      trim,
      hp,
      state,
      duck,
      meter,
    } satisfies ChannelNodes;
  }

  private async attachMainTrack(opts: AudioProcessorOptions) {
    if (!this.context) {
      return;
    }

    this.mainSourceNode?.disconnect();
    this.mainSourceStream = new MediaStream([opts.track]);
    this.mainSourceNode = this.context.createMediaStreamSource(this.mainSourceStream);
    await this.rebuildMainProcessing(opts);
  }

  private async rebuildMainProcessing(opts?: AudioProcessorOptions) {
    if (!this.context || !this.mainSourceNode) {
      return;
    }

    this.channelNodes.main?.source?.disconnect();
    this.channelNodes.main?.splitter?.disconnect();
    this.channelNodes.main?.merger?.disconnect();
    this.mainRnnoise?.disconnect();
    this.mainRnnoise?.destroy();
    this.mainRnnoise = undefined;
    this.mainRnnoiseBypass?.disconnect();
    this.mainRnnoiseBypass = undefined;

    const shouldUseKrisp =
      this.settings.noiseSuppression === "krisp" && !this.settings.musicMode;
    let useRnnoiseFallback = false;

    let sourceNode: AudioNode = this.mainSourceNode;
    if (shouldUseKrisp) {
      const krispModule = await this.loadKrispModule().catch(() => null);
      if (!krispModule?.isKrispNoiseFilterSupported?.()) {
        this.errorCallback?.(
          "Krisp is not available in this browser, so Vox fell back to RNNoise for voice cleanup.",
        );
        useRnnoiseFallback = true;
      } else {
      const baseOpts = opts ?? {
        kind: Track.Kind.Audio,
        track: this.mainTrack as MediaStreamTrack,
        audioContext: this.context,
      };
      if (!this.mainKrisp) {
          this.mainKrisp = krispModule.KrispNoiseFilter();
        await this.mainKrisp.init(baseOpts as AudioProcessorOptions);
      } else {
        await this.mainKrisp.restart(baseOpts as AudioProcessorOptions);
      }

      const krispTrack = this.mainKrisp.processedTrack;
      if (krispTrack) {
        const stream = new MediaStream([krispTrack]);
        sourceNode = this.context.createMediaStreamSource(stream);
      }
      }
    } else if (this.mainKrisp) {
      await this.mainKrisp.destroy();
      this.mainKrisp = undefined;
    }

    if (
      (this.settings.noiseSuppression === "rnnoise" || useRnnoiseFallback) &&
      !this.settings.musicMode
    ) {
      const rnnoiseModule = await this.loadRnnoiseModule().catch(() => null);
      if (!rnnoiseModule) {
        this.errorCallback?.("RNNoise could not be loaded, so Vox kept the standard input path.");
      } else {
        const wasmBinary = await ensureRnnoise(this.context, rnnoiseModule.loadRnnoise);
        this.mainRnnoise = new rnnoiseModule.RnnoiseWorkletNode(this.context, {
          maxChannels: 2,
          wasmBinary,
        });
        this.mainRnnoiseBypass = this.context.createGain();
        this.mainRnnoiseBypass.gain.value = 1;
        sourceNode.connect(this.mainRnnoise);
        sourceNode = this.mainRnnoise;
      }
    }

    this.connectSourceToChannel("main", sourceNode, true);
  }

  private connectSourceToChannel(
    channelId: "main" | "secondary" | "music" | "system",
    source: AudioNode,
    voiceChain: boolean,
  ) {
    if (!this.context) {
      return;
    }

    const nodes = this.channelNodes[channelId];
    if (!nodes) {
      return;
    }

    nodes.source?.disconnect();
    nodes.splitter?.disconnect();
    nodes.merger?.disconnect();
    nodes.trim.disconnect();
    nodes.hp.disconnect();
    nodes.gate?.disconnect();
    nodes.compressor?.disconnect();

    nodes.source = source;
    const splitter = this.context.createChannelSplitter(2);
    const merger = this.context.createChannelMerger(2);
    source.connect(splitter);
    const mode = this.settings.channels[channelId].channelMode;
    if (mode === "left") {
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 0, 1);
    } else if (mode === "right") {
      splitter.connect(merger, 1, 0);
      splitter.connect(merger, 1, 1);
    } else {
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 1, 1);
    }

    nodes.splitter = splitter;
    nodes.merger = merger;

    let tail: AudioNode = merger;
    tail.connect(nodes.trim);
    tail = nodes.trim;

    if (voiceChain) {
      nodes.hp.frequency.value = clamp(this.settings.highPassHz, 40, 180);
      tail.connect(nodes.hp);
      tail = nodes.hp;

      if (this.settings.gateEnabled) {
        const gate = new AudioWorkletNode(this.context, "vox-gate-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          parameterData: {
            thresholdDb: this.settings.gateThresholdDb,
            releaseMs: this.settings.gateReleaseMs,
          },
        });
        nodes.gate = gate;
        tail.connect(gate);
        tail = gate;
      } else {
        nodes.gate = undefined;
      }

      if (this.settings.compressorPreset !== "off") {
        const compressor = this.context.createDynamicsCompressor();
        if (this.settings.compressorPreset === "speech") {
          compressor.threshold.value = -24;
          compressor.knee.value = 18;
          compressor.ratio.value = 3.5;
          compressor.attack.value = 0.008;
          compressor.release.value = 0.18;
        } else {
          compressor.threshold.value = -18;
          compressor.knee.value = 24;
          compressor.ratio.value = 2.2;
          compressor.attack.value = 0.02;
          compressor.release.value = 0.26;
        }
        nodes.compressor = compressor;
        tail.connect(compressor);
        tail = compressor;
      } else {
        nodes.compressor = undefined;
      }
    }

    tail.connect(nodes.state);
    this.applySettings(this.settings);
  }

  private applySettings(settings: HostStudioSettings) {
    if (!this.context || !this.masterGain || !this.headphoneTap) {
      return;
    }

    this.channelNodes.main && (this.channelNodes.main.trim.gain.value = dbToGain(settings.channels.main.gainDb));
    this.channelNodes.secondary &&
      (this.channelNodes.secondary.trim.gain.value = dbToGain(settings.channels.secondary.gainDb));
    this.channelNodes.music &&
      (this.channelNodes.music.trim.gain.value = dbToGain(settings.channels.music.gainDb));
    this.channelNodes.system &&
      (this.channelNodes.system.trim.gain.value = dbToGain(settings.channels.system.gainDb));

    this.masterGain.gain.value = dbToGain(settings.masterGainDb);
    this.headphoneTap.gain.value = settings.headphoneMonitoring ? 1 : 0;

    if (this.channelNodes.main?.hp) {
      this.channelNodes.main.hp.frequency.value = settings.highPassHz;
    }
    if (this.channelNodes.secondary?.hp) {
      this.channelNodes.secondary.hp.frequency.value = settings.highPassHz;
    }

    this.applyStateGains();
  }

  private applyStateGains() {
    if (!this.context) {
      return;
    }
    const context = this.context;

    const soloedChannels = (["main", "secondary", "music", "system"] as const).filter(
      (channelId) =>
        this.settings.channels[channelId].enabled && this.settings.channels[channelId].solo,
    );

    (["main", "secondary", "music", "system"] as const).forEach((channelId) => {
      const nodes = this.channelNodes[channelId];
      if (!nodes) {
        return;
      }

      const channel = this.settings.channels[channelId];
      const active =
        channel.enabled && !channel.muted && (soloedChannels.length === 0 || channel.solo);
      nodes.state.gain.value = active ? 1 : 0.0001;
      if (nodes.duck) {
        nodes.duck.gain.cancelScheduledValues(context.currentTime);
        const duckTarget =
          channelId === "music" &&
          this.settings.duckingEnabled &&
          this.speaking &&
          !this.settings.musicMode
            ? dbToGain(this.settings.duckingDepthDb)
            : 1;
        nodes.duck.gain.setTargetAtTime(duckTarget, context.currentTime, 0.08);
      }
    });
  }
}
