class VoxMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameCounter = 0;
    this.updateInterval = Math.max(1, Math.round(sampleRate / 30 / 128));
    this.clipHoldUntil = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    let peak = 0;
    let sumSquares = 0;
    let truePeak = 0;
    let sampleCount = 0;

    for (let channelIndex = 0; channelIndex < input.length; channelIndex += 1) {
      const channel = input[channelIndex];
      for (let index = 0; index < channel.length; index += 1) {
        const sample = channel[index];
        const abs = Math.abs(sample);
        peak = Math.max(peak, abs);
        sumSquares += sample * sample;
        sampleCount += 1;

        if (index > 0) {
          const previous = channel[index - 1];
          for (let step = 1; step < 4; step += 1) {
            const interpolated = previous + (sample - previous) * (step / 4);
            truePeak = Math.max(truePeak, Math.abs(interpolated));
          }
        } else {
          truePeak = Math.max(truePeak, abs);
        }
      }
    }

    if (peak >= 0.995 || truePeak >= 0.995) {
      this.clipHoldUntil = currentTime + 2;
    }

    this.frameCounter += 1;
    if (this.frameCounter >= this.updateInterval) {
      this.frameCounter = 0;
      this.port.postMessage({
        peak,
        rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
        truePeak,
        clipped: this.clipHoldUntil > currentTime,
        clipHoldUntil: this.clipHoldUntil,
      });
    }

    return true;
  }
}

registerProcessor("vox-meter-processor", VoxMeterProcessor);
