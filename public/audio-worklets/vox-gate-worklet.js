class VoxGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "thresholdDb",
        defaultValue: -48,
        minValue: -90,
        maxValue: 0,
        automationRate: "k-rate",
      },
      {
        name: "releaseMs",
        defaultValue: 220,
        minValue: 20,
        maxValue: 1000,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this.gain = 1;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const thresholdDb = parameters.thresholdDb[0];
    const releaseMs = parameters.releaseMs[0];
    const threshold = Math.pow(10, thresholdDb / 20);
    const releaseCoeff = Math.exp(-1 / Math.max(1, (releaseMs / 1000) * sampleRate));

    let peak = 0;
    for (let channelIndex = 0; channelIndex < input.length; channelIndex += 1) {
      const channel = input[channelIndex];
      for (let index = 0; index < channel.length; index += 1) {
        peak = Math.max(peak, Math.abs(channel[index]));
      }
    }

    const targetGain = peak >= threshold ? 1 : 0.0001;
    this.gain = targetGain > this.gain ? targetGain : this.gain * releaseCoeff;

    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const inChannel = input[channelIndex] || input[0];
      const outChannel = output[channelIndex];
      for (let index = 0; index < outChannel.length; index += 1) {
        outChannel[index] = (inChannel?.[index] || 0) * this.gain;
      }
    }

    return true;
  }
}

registerProcessor("vox-gate-processor", VoxGateProcessor);
