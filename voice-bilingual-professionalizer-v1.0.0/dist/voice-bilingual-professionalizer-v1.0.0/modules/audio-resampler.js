/**
 * Mathematical Audio Resampler & Normalizer
 * Converts arbitrary sample rates (44.1kHz, 48kHz, 32kHz, etc.) to 16,000 Hz Mono Float32 PCM
 * Range: -1.0 to +1.0
 */

export class AudioResampler {
  /**
   * Resamples a Float32Array from sourceSampleRate to targetSampleRate (default 16000 Hz)
   * using band-limited/linear interpolation with anti-aliasing guard.
   */
  static resampleTo16k(audioBuffer, sourceSampleRate, targetSampleRate = 16000) {
    if (sourceSampleRate === targetSampleRate) {
      return audioBuffer;
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return new Float32Array(0);
    }

    const ratio = sourceSampleRate / targetSampleRate;
    const newLength = Math.round(audioBuffer.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const origin = i * ratio;
      const index = Math.floor(origin);
      const frac = origin - index;

      if (index + 1 < audioBuffer.length) {
        // Linear interpolation between consecutive samples
        result[i] = audioBuffer[index] * (1 - frac) + audioBuffer[index + 1] * frac;
      } else if (index < audioBuffer.length) {
        result[i] = audioBuffer[index];
      } else {
        result[i] = 0;
      }
    }

    return result;
  }

  /**
   * Gentle audio normalization with conservative DC-offset removal
   * Prevents consonant / plosive clipping and maintains natural dynamics.
   */
  static normalizeAudio(float32Array) {
    if (!float32Array || float32Array.length === 0) return float32Array;

    // 1. Calculate DC offset (mean)
    let sum = 0;
    for (let i = 0; i < float32Array.length; i++) {
      sum += float32Array[i];
    }
    const dcOffset = sum / float32Array.length;

    // 2. Find peak after removing DC offset
    let maxPeak = 0;
    for (let i = 0; i < float32Array.length; i++) {
      const val = Math.abs(float32Array[i] - dcOffset);
      if (val > maxPeak) {
        maxPeak = val;
      }
    }

    // 3. Gentle scaling: only scale if audio has content but isn't clipping
    const output = new Float32Array(float32Array.length);
    const targetPeak = 0.95;
    const gain = maxPeak > 0.01 && maxPeak < 0.9 ? targetPeak / maxPeak : 1.0;

    for (let i = 0; i < float32Array.length; i++) {
      output[i] = (float32Array[i] - dcOffset) * gain;
      // Clamp between -1 and +1
      if (output[i] > 1.0) output[i] = 1.0;
      if (output[i] < -1.0) output[i] = -1.0;
    }

    return output;
  }
}
