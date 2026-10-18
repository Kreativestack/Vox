class VoxLoudnessProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameCounter = 0;
    this.energy400 = [];
    this.energy3s = [];
    this.blocks400 = [];
    this.samplesSinceBlock = 0;
    this.sumSquares400 = 0;
    this.sumSquares3s = 0;
    this.sampleWindow400 = Math.max(1, Math.round(sampleRate * 0.4));
    this.sampleWindow3s = Math.max(1, Math.round(sampleRate * 3));
    this.postEveryFrames = Math.max(1, Math.round(sampleRate / 15 / 128));
  }

  pushEnergy(buffer, value, limit) {
    buffer.push(value);
    while (buffer.length > limit) {
      buffer.shift();
    }
  }

  toLufs(meanSquare) {
    if (!meanSquare || meanSquare <= 0) {
      return null;
    }
    return -0.691 + 10 * Math.log10(meanSquare);
  }

  computeIntegrated() {
    if (this.blocks400.length === 0) {
      return null;
    }

    const loudBlocks = this.blocks400
      .map((energy) => ({ energy, loudness: this.toLufs(energy) }))
      .filter((entry) => entry.loudness != null && entry.loudness >= -70);

    if (loudBlocks.length === 0) {
      return null;
    }

    const ungatedAverage =
      loudBlocks.reduce((sum, entry) => sum + entry.energy, 0) / loudBlocks.length;
    const relativeGate = (this.toLufs(ungatedAverage) ?? -70) - 10;
    const gated = loudBlocks.filter((entry) => (entry.loudness ?? -100) >= relativeGate);
    if (gated.length === 0) {
      return null;
    }

    const average = gated.reduce((sum, entry) => sum + entry.energy, 0) / gated.length;
    return this.toLufs(average);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    for (let index = 0; index < input[0].length; index += 1) {
      let sampleEnergy = 0;
      for (let channelIndex = 0; channelIndex < input.length; channelIndex += 1) {
        const sample = input[channelIndex][index] || 0;
        sampleEnergy += sample * sample;
      }

      this.energy400.push(sampleEnergy);
      this.energy3s.push(sampleEnergy);
      this.sumSquares400 += sampleEnergy;
      this.sumSquares3s += sampleEnergy;
      this.samplesSinceBlock += 1;

      while (this.energy400.length > this.sampleWindow400) {
        this.sumSquares400 -= this.energy400.shift();
      }
      while (this.energy3s.length > this.sampleWindow3s) {
        this.sumSquares3s -= this.energy3s.shift();
      }

      if (this.samplesSinceBlock >= this.sampleWindow400) {
        const blockEnergy = this.sumSquares400 / Math.max(1, this.energy400.length);
        this.pushEnergy(this.blocks400, blockEnergy, 600);
        this.samplesSinceBlock = 0;
      }
    }

    this.frameCounter += 1;
    if (this.frameCounter >= this.postEveryFrames) {
      this.frameCounter = 0;
      this.port.postMessage({
        momentary: this.toLufs(this.sumSquares400 / Math.max(1, this.energy400.length)),
        shortTerm: this.toLufs(this.sumSquares3s / Math.max(1, this.energy3s.length)),
        integrated: this.computeIntegrated(),
      });
    }

    return true;
  }
}

registerProcessor("vox-loudness-processor", VoxLoudnessProcessor);
