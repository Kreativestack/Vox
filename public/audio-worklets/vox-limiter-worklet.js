class VoxLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "lookaheadMs",
        defaultValue: 5,
        minValue: 1,
        maxValue: 20,
        automationRate: "k-rate",
      },
      {
        name: "ceilingDb",
        defaultValue: -1,
        minValue: -12,
        maxValue: 0,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this.position = 0;
    this.currentGain = 1;
    this.buffers = [new Float32Array(2048), new Float32Array(2048)];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const lookaheadSamples = Math.max(
      1,
      Math.min(this.buffers[0].length - 129, Math.round((parameters.lookaheadMs[0] / 1000) * sampleRate)),
    );
    const ceiling = Math.pow(10, parameters.ceilingDb[0] / 20);
    const channelCount = Math.min(output.length, input.length);

    for (let index = 0; index < input[0].length; index += 1) {
      let futurePeak = 0;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        this.buffers[channelIndex][this.position] = input[channelIndex][index];
      }

      for (let offset = 0; offset < lookaheadSamples; offset += 1) {
        const bufferIndex = (this.position + offset) % this.buffers[0].length;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          futurePeak = Math.max(futurePeak, Math.abs(this.buffers[channelIndex][bufferIndex]));
        }
      }

      const targetGain = futurePeak > ceiling ? ceiling / futurePeak : 1;
      this.currentGain += (targetGain - this.currentGain) * 0.35;

      const readIndex =
        (this.position - lookaheadSamples + this.buffers[0].length) % this.buffers[0].length;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        output[channelIndex][index] = this.buffers[channelIndex][readIndex] * this.currentGain;
      }

      this.position = (this.position + 1) % this.buffers[0].length;
    }

    return true;
  }
}

registerProcessor("vox-limiter-processor", VoxLimiterProcessor);
