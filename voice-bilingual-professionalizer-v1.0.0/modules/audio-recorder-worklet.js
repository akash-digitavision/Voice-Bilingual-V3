// audio-recorder-worklet.js
// AudioWorkletProcessor running on the Web Audio rendering thread
// Buffers incoming audio frames and sends raw Float32 chunks to main thread

class AudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = true;
    this.port.onmessage = (event) => {
      if (event.data && event.data.command === 'stop') {
        this.isRecording = false;
      } else if (event.data && event.data.command === 'start') {
        this.isRecording = true;
      }
    };
  }

  process(inputs, outputs, parameters) {
    if (!this.isRecording) {
      return true;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    // Mix input channels down to mono
    const channelCount = input.length;
    const sampleCount = input[0].length;
    const monoSamples = new Float32Array(sampleCount);

    if (channelCount === 1) {
      monoSamples.set(input[0]);
    } else {
      for (let s = 0; s < sampleCount; s++) {
        let sum = 0;
        for (let c = 0; c < channelCount; c++) {
          sum += input[c][s];
        }
        monoSamples[s] = sum / channelCount;
      }
    }

    // Post Float32 raw frame to the main thread
    this.port.postMessage({
      type: 'AUDIO_CHUNK',
      samples: monoSamples
    }, [monoSamples.buffer]);

    return true;
  }
}

registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
