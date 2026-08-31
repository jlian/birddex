import Accelerate
import CoreML
import Foundation

/// On-device bird identification: the Core ML vision tower plus the Strategy I
/// ranker.
///
/// The iOS counterpart of src/lib/bird-id-local.ts. Everything is bundled, so
/// there is no download step and no cache: 37 MiB Core ML tower, 8.2 MiB text
/// classifier, 33 MiB occurrence prior.
///
/// The prior is the v4 blob, bundled UNCOMPRESSED by
/// ios/scripts/sync-birdid-assets.sh: 34,541,674 bytes = 32.94 MiB, from a
/// 21.54 MiB .gz. The 23 MiB quoted here before was the v3 blob.
///
/// Classification is a cosine similarity against a frozen 10,994 x 768 matrix
/// of BioCLIP-2 text embeddings, so the text encoder never runs on device.
actor BirdIdEngine {
    static let shared = BirdIdEngine()

    struct Result: Sendable {
        let commonName: String
        let scientificName: String
        let taxonIdx: Int
        /// Displayed confidence: P_cal * P(species | bird).
        ///
        /// The probe multiplier is the SAME positive scalar on every candidate
        /// of one photo, so it cannot reorder them.
        let confidence: Double
        /// Nil when no geographic prior applied, so the caller can say so.
        let logP: Double?
        /// Calibrated P(bird) for the whole photo. Identical across the
        /// candidates of one identify() call.
        let pBird: Double
    }

    enum EngineError: Error, CustomStringConvertible {
        case missingResource(String)
        case badClassifierLength(Int)
        case speciesCountMismatch(classifier: Int, taxonomy: Int)
        case noEmbedding

        var description: String {
            switch self {
            case .missingResource(let n): "bird ID asset missing from the bundle: \(n)"
            case .badClassifierLength(let n): "text classifier length \(n) is not a multiple of 768"
            case .speciesCountMismatch(let c, let t):
                "text classifier has \(c) species rows plus a probe row but taxonomy has \(t)"
            case .noEmbedding: "Core ML returned no embedding"
            }
        }
    }

    /// Must match MODEL_ASSETS in src/lib/bird-id-local-adapter.ts. Pinned
    /// against the shared golden fixture in BirdIDParityTests, because a silent
    /// drift here re-weights the prior against similarity on every photo.
    ///
    /// REFITTED for the v4 blob at occFloor = 3e-5 and occBackoffK = 0.3.
    /// Not transferable across either constant.
    /// The probe values are the a060-int8 arm, matching BIRD_PROBE in the web
    /// adapter byte for byte. See that file for what each was measured to do:
    /// at this threshold, 0.45% of validation birds are flagged, 74.10% of hard
    /// negatives and 84.90% of Imagenette are rejected, and 0.0375% of 8,000
    /// unseen NABirds are rejected.
    static let calibration = BirdRanker.Calibration(
        temperature: 0.007435,
        beta: 1.1634,
        probe: BirdRanker.BirdProbe(
            bias: 1.7004907607405835,
            plattA: 1.248338657716024,
            plattB: 2.1821600341974303,
            threshold: 0.3736373465
        )
    )
    static let taxonomySha16 = "a217aceafc34f8ba"

    /// Abstention threshold on the CALIBRATED P(bird) scale.
    ///
    /// Exposed because the gate lives in the caller, not in identify():
    /// the engine reports pBird and the presentation layer decides to
    /// abstain, which is the same split the web takes between
    /// bird-id-local.ts and identifyBirdLocally in the adapter.
    static var birdProbeThreshold: Double { calibration.probe.threshold }


    /// Prompt for a crop below this. Measured on 400 labelled held-out photos
    /// plus 393 Imagenette non-birds: 0.8 keeps 93% of real birds and rejects
    /// 76% of dog photos, against 95% / 70% at 0.7.
    ///
    /// A dog is the hard case and no threshold fixes it, because this is
    /// zero-shot cosine over 10,994 BIRD names with no "not a bird" class, so a
    /// furry four-legged animal lands somewhere plausible. A pre-rerank vision
    /// gate was measured as an alternative and is WORSE on dogs while costing
    /// 17 points of bird coverage, so it is not shipped.
    static let confidencePromptThreshold = 0.8

    /// Format a confidence for display.
    ///
    /// Confidence is never actually zero, but 91% of the 2nd-to-5th candidates
    /// fall below 0.5% and round to a flat "0%", which reads as "impossible"
    /// rather than "very unlikely". 0.005 is exactly where integer rounding
    /// starts producing 0, so below it the value is reported as a bound.
    ///
    /// The number itself is left alone: measured against ground truth it is
    /// well calibrated (mean 0.963 against 94.3% accuracy, ECE 0.021).
    static func formatConfidence(_ confidence: Double) -> String {
        guard confidence.isFinite, confidence >= 0 else { return "-" }
        if confidence < 0.005 { return "<0.5%" }
        return "\(Int((confidence * 100).rounded()))%"
    }

    /// Candidates handed to the reranker. The recall ceiling at 25 is 97.14%.
    private static let candidateCount = 25
    private static let embedDim = 768

    private struct Loaded {
        let model: MLModel
        /// Species rows ONLY: the probe row is split off into `probeW` so the
        /// vDSP_mmul below can never emit it as a candidate.
        let classifier: [Float]
        /// Last row of the classifier file: the 768-d probe weights.
        let probeW: [Float]
        let speciesCount: Int
        let names: [(common: String, scientific: String)]
        let occurrence: OccurrenceBlob
    }

    private var loaded: Loaded?

    /// Load once. Safe to call repeatedly; later calls are no-ops.
    func warmUp() throws {
        _ = try ensureLoaded()
    }

    private func ensureLoaded() throws -> Loaded {
        if let loaded { return loaded }

        guard let modelURL = Bundle.main.url(forResource: "WingCLIP", withExtension: "mlmodelc") else {
            throw EngineError.missingResource("WingCLIP.mlmodelc")
        }
        let config = MLModelConfiguration()
        // ANE where available: 2.3 ms against 8.9 ms CPU on an M-series Mac.
        config.computeUnits = .all
        let model = try MLModel(contentsOf: modelURL, configuration: config)

        guard let classifierURL = Bundle.main.url(forResource: "text_classifier_int8",
                                                  withExtension: "bin") else {
            throw EngineError.missingResource("text_classifier_int8.bin")
        }
        let (rows, rowCount) = try Self.decodeInt8Rows(
            try Data(contentsOf: classifierURL), dim: Self.embedDim)

        // The LAST row is the bird/not-bird probe, not a species. Splitting it
        // off keeps the similarity matmul exactly as wide as the taxonomy.
        //
        // The count check is what catches a stale bundled classifier: an older
        // 11,167-row file decodes fine and would otherwise silently hand its
        // last SPECIES row to the probe. It is now 10,994 rows plus the probe.
        let speciesCount = rowCount - 1
        let names = try Self.loadTaxonomyNames()
        guard speciesCount > 0, names.count == speciesCount else {
            throw EngineError.speciesCountMismatch(classifier: speciesCount, taxonomy: names.count)
        }
        let classifier = Array(rows[0..<(speciesCount * Self.embedDim)])
        let probeW = Array(rows[(speciesCount * Self.embedDim)...])

        guard let priorURL = Bundle.main.url(forResource: "occurrence", withExtension: "bin") else {
            throw EngineError.missingResource("occurrence.bin")
        }
        let occurrence = try OccurrenceBlob(raw: [UInt8](try Data(contentsOf: priorURL)),
                                            taxonomySha16: Self.taxonomySha16)

        let l = Loaded(model: model, classifier: classifier, probeW: probeW,
                       speciesCount: speciesCount,
                       names: names, occurrence: occurrence)
        loaded = l
        return l
    }

    /// Identify one photo. `location` is optional; without it the ranker
    /// degrades to vision-only rather than guessing.
    ///
    /// `month` is 1-12. The old server API took 0-11, so a caller that still
    /// subtracts one will silently lose the prior for January and shift every
    /// other month.
    func identify(
        imageData: Data,
        location: (lat: Double, lon: Double)?,
        month: Int?,
        topK: Int = 5
    ) throws -> [Result] {
        let l = try ensureLoaded()

        guard let rgb = PhotoDecoder.decode(imageData) else {
            throw EngineError.missingResource("decodable image")
        }
        let pixels = CLIPPreprocess.preprocess(rgb)
        let embedding = try embed(pixels, model: l.model)
        let sims = similarities(embedding, l)
        let candidates = topCandidates(sims, count: Self.candidateCount)

        // Bird/not-bird probe on the SAME normalised embedding. Deliberately
        // OUTSIDE the species softmax: a "not a bird" class inside it would
        // compete with the species and change which one wins, whereas a
        // multiplier applied afterwards scales all of them equally.
        let pBird = Self.birdProbability(embedding, l)

        let scored = BirdRanker.rank(candidates, calibration: Self.calibration,
                                     occurrence: l.occurrence, location: location, month: month)
        let probs = BirdRanker.scoresToProbs(scored)

        return scored.prefix(topK).enumerated().map { i, s in
            // P_cal * P(species | bird). `scored` fixed the order before pBird
            // was ever multiplied in.
            Result(commonName: l.names[s.idx].common,
                   scientificName: l.names[s.idx].scientific,
                   taxonIdx: s.idx,
                   confidence: pBird * probs[i],
                   logP: s.logP,
                   pBird: pBird)
        }
    }

    private func embed(_ pixels: [Float], model: MLModel) throws -> [Float] {
        // Stays 224: preprocess() resizes the SHORTER side to 248 and then
        // centre-crops 224, so only the resize target moved, not the tensor.
        let array = try MLMultiArray(shape: [1, 3, 224, 224], dataType: .float32)
        pixels.withUnsafeBufferPointer { src in
            let dst = array.dataPointer.bindMemory(to: Float.self, capacity: pixels.count)
            dst.update(from: src.baseAddress!, count: pixels.count)
        }
        let input = try MLDictionaryFeatureProvider(
            dictionary: ["image": MLFeatureValue(multiArray: array)])
        let out = try model.prediction(from: input)
        guard let value = out.featureValue(for: "embedding")?.multiArrayValue else {
            throw EngineError.noEmbedding
        }
        let ptr = value.dataPointer.bindMemory(to: Float.self, capacity: value.count)
        return Array(UnsafeBufferPointer(start: ptr, count: value.count))
    }

    /// Calibrated P(bird) for one embedding.
    ///
    /// P_raw = sigmoid(w . e + bias) on the L2-normalised embedding, then
    /// P_cal = sigmoid(plattA * logit(P_raw) + plattB). The logit is clamped at
    /// 1e-7, matching the clip the Platt pair was fitted under: the probe
    /// saturates on obvious birds and Float rounds those to exactly 1, where an
    /// unclamped logit is infinite and the Platt map returns NaN.
    private static func birdProbability(_ embedding: [Float], _ l: Loaded) -> Double {
        return birdProbability(embedding, probeW: l.probeW)
    }

    /// The probe computation itself, taking the weight row directly.
    ///
    /// Split out from the  overload so a test can drive it with a known
    /// embedding and the real bundled probe row, without a Core ML forward
    /// pass. The accuracy tests only check species ORDER, and the probe is a
    /// positive scalar multiplier that cannot change an order, so without a
    /// golden on THIS function a wrong dot product, a swapped Platt pair or a
    /// missing normalisation all still pass.
    static func birdProbability(_ embedding: [Float], probeW: [Float]) -> Double {
        var norm: Float = 0
        vDSP_svesq(embedding, 1, &norm, vDSP_Length(embedDim))
        norm = norm.squareRoot()
        if norm == 0 { norm = 1 }
        var dot: Float = 0
        vDSP_dotpr(probeW, 1, embedding, 1, &dot, vDSP_Length(embedDim))
        let raw = 1.0 / (1.0 + exp(-(Double(dot / norm) + calibration.probe.bias)))
        let eps = 1e-7
        let c = min(max(raw, eps), 1 - eps)
        let z = log(c / (1 - c))
        return 1.0 / (1.0 + exp(-(calibration.probe.plattA * z + calibration.probe.plattB)))
    }

    /// Full 10,994-way cosine, then the caller keeps the top 25.
    private func similarities(_ embedding: [Float], _ l: Loaded) -> [Float] {
        var norm: Float = 0
        vDSP_svesq(embedding, 1, &norm, vDSP_Length(Self.embedDim))
        norm = norm.squareRoot()
        if norm == 0 { norm = 1 }

        // The classifier rows are already L2-normalised, so normalising the
        // embedding is all that is needed to turn the dot into a cosine.
        var unit = [Float](repeating: 0, count: Self.embedDim)
        vDSP_vsdiv(embedding, 1, &norm, &unit, 1, vDSP_Length(Self.embedDim))

        var sims = [Float](repeating: 0, count: l.speciesCount)
        vDSP_mmul(l.classifier, 1, unit, 1, &sims, 1,
                  vDSP_Length(l.speciesCount), 1, vDSP_Length(Self.embedDim))
        return sims
    }

    /// Partial top-K rather than a full sort: 10,994 sorted to take 25 is
    /// wasted work for identical output.
    private func topCandidates(_ sims: [Float], count: Int) -> [BirdRanker.Candidate] {
        var best: [(idx: Int, sim: Float)] = []
        best.reserveCapacity(count + 1)
        var worst: Float = -.infinity
        for (s, v) in sims.enumerated() {
            if best.count == count && v <= worst { continue }
            var p = best.count
            while p > 0 && best[p - 1].sim < v { p -= 1 }
            best.insert((s, v), at: p)
            if best.count > count { best.removeLast() }
            worst = best[best.count - 1].sim
        }
        return best.map { BirdRanker.Candidate(idx: $0.idx, sim: Double($0.sim)) }
    }

    /// Decode the int8 rows: an int8 matrix followed by fp32 per-row
    /// scales. Row s is q[s] * scale[s]. The LAST row is the probe, not a
    /// species; the caller splits it off.
    ///
    /// Dequantised to Float up front, 34 MiB resident, because BLAS has no int8
    /// gemv and converting per row on every identify would cost more than the
    /// memory saves.
    static func decodeInt8Rows(_ data: Data, dim: Int) throws -> ([Float], Int) {
        let n = data.count / (dim + 4)
        guard n > 0, n * (dim + 4) == data.count else {
            throw EngineError.badClassifierLength(data.count)
        }
        var out = [Float](repeating: 0, count: n * dim)
        data.withUnsafeBytes { raw in
            let q = raw.bindMemory(to: Int8.self)
            let scales = raw.baseAddress!.advanced(by: n * dim)
                .bindMemory(to: Float.self, capacity: n)
            out.withUnsafeMutableBufferPointer { o in
                for s in 0..<n {
                    let base = s * dim
                    let scale = scales[s]
                    for i in 0..<dim {
                        o[base + i] = Float(q[base + i]) * scale
                    }
                }
            }
        }
        return (out, n)
    }

    static func loadTaxonomyNames() throws -> [(common: String, scientific: String)] {
        guard let url = Bundle.main.url(forResource: "taxonomy", withExtension: "json") else {
            throw EngineError.missingResource("taxonomy.json")
        }
        let raw = try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [[Any]] ?? []
        return raw.map {
            (common: $0.first as? String ?? "",
             scientific: $0.count > 1 ? ($0[1] as? String ?? "") : "")
        }
    }
}
