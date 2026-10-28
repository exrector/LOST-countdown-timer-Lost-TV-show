import Foundation

// RNNoise (native/vendor/rnnoise) at its native 48 kHz, then 3:1 decimation to the
// 16-kHz signed-16-bit mono stream the Muse bridge accepts. One instance per
// recording, used only on the microphone capture queue. It exists only while
// RESET is held: nothing processes audio between recordings.
final class VoiceDenoiser {
    private static let rate = 48000.0
    // 63-tap Blackman-windowed sinc low-pass at 7.2 kHz, unity DC gain: keeps speech
    // up to the 8-kHz Nyquist of the output and suppresses aliasing before decimation.
    private static let taps: [Float] = {
        let count = 63, cutoff = 7200.0 / rate, middle = Double(count - 1) / 2
        var h = (0..<count).map { i -> Double in
            let x = Double(i) - middle
            let sinc = x == 0 ? 2 * cutoff : sin(2 * Double.pi * cutoff * x) / (Double.pi * x)
            let window = 0.42 - 0.5 * cos(2 * Double.pi * Double(i) / Double(count - 1))
                + 0.08 * cos(4 * Double.pi * Double(i) / Double(count - 1))
            return sinc * window
        }
        let sum = h.reduce(0, +); h = h.map { $0 / sum }
        return h.map(Float.init)
    }()
    // Full RNNoise suppression leaves artefacts that cost speech recognition words; a
    // little of the original under the clean signal limits suppression to this floor.
    static let defaultDryGain: Float = 0.1 // −20 dB
    private let state: OpaquePointer
    private let frame = Int(rnnoise_get_frame_size())
    private let dryGain: Float
    private var pending: [Float] = []
    private var dry: [Float] // input delayed by RNNoise's two-frame latency
    private var line = [Float](repeating: 0, count: VoiceDenoiser.taps.count - 1)
    private var skip = 0

    init?(dryGain: Float = VoiceDenoiser.defaultDryGain) {
        guard let created = rnnoise_create(nil) else { return nil }
        state = created; self.dryGain = dryGain
        dry = [Float](repeating: 0, count: 2 * Int(rnnoise_get_frame_size()))
    }
    deinit { rnnoise_destroy(state) }

    // samples: 48-kHz mono Float32 in [-1, 1]. Returns little-endian Int16 at 16 kHz.
    func process(_ samples: UnsafeBufferPointer<Float>) -> Data {
        pending.append(contentsOf: samples)
        var clean: [Float] = []
        var input = [Float](repeating: 0, count: frame), output = [Float](repeating: 0, count: frame)
        var start = 0
        while pending.count - start >= frame {
            // RNNoise works on 16-bit-scaled floats.
            for i in 0..<frame { input[i] = pending[start + i] * 32768 }
            _ = rnnoise_process_frame(state, &output, input)
            dry.append(contentsOf: pending[start..<start + frame])
            for i in 0..<frame { clean.append(output[i] / 32768 + dryGain * dry[i]) }
            dry.removeFirst(frame)
            start += frame
        }
        pending.removeFirst(start)
        return decimate(clean)
    }

    private func decimate(_ block: [Float]) -> Data {
        let taps = Self.taps, x = line + block
        var out = Data(capacity: block.count / 3 * 2 + 2)
        var n = taps.count - 1 + skip
        while n < x.count {
            var acc: Float = 0
            for k in 0..<taps.count { acc += taps[k] * x[n - k] }
            let sample = Int16(max(-32768, min(32767, (acc * 32768).rounded())))
            withUnsafeBytes(of: sample.littleEndian) { out.append(contentsOf: $0) }
            n += 3
        }
        skip = n - x.count
        line = Array(x.suffix(taps.count - 1))
        return out
    }
}
