import Foundation
import UIKit

struct IntentDataProvider {
    @MainActor
    func fetchAllData() async throws -> AllDataResponse {
        try ensureProtectedDataAvailable()
        do {
            let auth = AuthService.shared
            try await auth.ensureAnonymousSession()
            return try await DataService(auth: auth).fetchAllData()
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw IntentDataError.map(error)
        }
    }

    @MainActor
    func exportSightings() async throws -> Data {
        try ensureProtectedDataAvailable()
        do {
            let auth = AuthService.shared
            await auth.validateSession()
            guard auth.isRegisteredAccount else { throw IntentDataError.notSignedIn }
            return try await DataService(auth: auth).exportSightingsCSV()
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw IntentDataError.map(error)
        }
    }

    @MainActor
    private func ensureProtectedDataAvailable() throws {
        guard UIApplication.shared.isProtectedDataAvailable else {
            throw IntentDataError.deviceLocked
        }
    }
}

enum RecentSpeciesResolver {
    static func names(from response: AllDataResponse, limit: Int = 5) -> [String] {
        let outingDates = Dictionary(uniqueKeysWithValues: response.outings.map {
            ($0.id, DateFormatting.sortDate($0.startTime))
        })

        var seen = Set<String>()
        return response.observations
            .filter { $0.certainty == .confirmed && outingDates[$0.outingId] != nil }
            .sorted {
                let leftDate = outingDates[$0.outingId] ?? .distantPast
                let rightDate = outingDates[$1.outingId] ?? .distantPast
                return leftDate > rightDate
            }
            .compactMap { observation in
                let name = getDisplayName(observation.speciesName)
                return seen.insert(name.lowercased()).inserted ? name : nil
            }
            .prefix(limit)
            .map { $0 }
    }
}

enum IntentDataError: LocalizedError, Equatable {
    case notSignedIn
    case deviceLocked
    case offline
    case timedOut
    case rateLimited
    case server
    case noRecentSpecies

    static func map(_ error: Error) -> IntentDataError {
        if let intentError = error as? IntentDataError { return intentError }
        if let serviceError = error as? DataServiceError,
             case .http(let status, _, _, _) = serviceError,
           status == 429 {
            return .rateLimited
        }
        switch AppError.map(error) {
        case .offline: return .offline
        case .timedOut: return .timedOut
        case .sessionExpired: return .notSignedIn
        case .rateLimited: return .rateLimited
        case .server, .invalidResponse: return .server
        default: return .server
        }
    }

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            "Open WingDex and sign in first."
        case .deviceLocked:
            "Unlock your iPhone, then run this WingDex shortcut again."
        case .offline:
            "WingDex is offline. Check your connection and try again."
        case .timedOut:
            "WingDex took too long to respond. Try again."
        case .rateLimited:
            "WingDex is receiving too many requests. Try again later."
        case .server:
            "WingDex could not load your data. Try again later."
        case .noRecentSpecies:
            "Your WingDex does not have any confirmed species yet."
        }
    }
}