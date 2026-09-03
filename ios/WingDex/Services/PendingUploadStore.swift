import Foundation
import SwiftData

enum PendingUploadRecoveryKeys {
  static let reauthenticationAccountID = "pendingUploadReauthentication"
}

struct PendingPhotoUpload: Codable, Identifiable, Sendable {
  let id: String
  let accountID: String
  let createdAt: Date
  let locationName: String
  let outing: Outing?
  let outingRecoverySnapshot: Outing?
  let photos: [DataService.PhotoPayload]
  let observations: [BirdObservation]
}

struct PendingUploadEntry: Identifiable, Sendable {
  let id: String
  let accountID: String
  let createdAt: Date
  let locationName: String
  let upload: PendingPhotoUpload?
  let lastError: String?
  let requiresAttention: Bool
  let awaitingReconciliation: Bool
}

@MainActor
protocol PendingUploadStoring: AnyObject {
  func load(accountID: String) throws -> [PendingUploadEntry]
  func enqueue(_ upload: PendingPhotoUpload) throws
  func markFailed(
    id: String,
    accountID: String,
    message: String,
    requiresAttention: Bool,
    awaitingReconciliation: Bool
  ) throws
  func markAwaitingReconciliation(id: String, accountID: String) throws
  func remove(id: String, accountID: String) throws
  func clear(accountID: String) throws
  func reassign(from sourceAccountID: String, to targetAccountID: String) throws
}

@MainActor
final class PendingUploadStore: PendingUploadStoring {
  private let container: ModelContainer
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  init(isStoredInMemoryOnly: Bool = false, storeURL: URL? = nil) throws {
    let schema = Schema([PendingUploadRecord.self])
    if isStoredInMemoryOnly {
      container = try ModelContainer(
        for: schema,
        configurations: ModelConfiguration(isStoredInMemoryOnly: true)
      )
      return
    }

    let url = try storeURL ?? Self.defaultStoreURL()
    let configuration = ModelConfiguration(
      "WingDexPendingUploads",
      schema: schema,
      url: url,
      cloudKitDatabase: .none
    )
    container = try ModelContainer(for: schema, configurations: configuration)
  }

  func load(accountID: String) throws -> [PendingUploadEntry] {
    let context = ModelContext(container)
    let descriptor = FetchDescriptor<PendingUploadRecord>(
      predicate: #Predicate { $0.accountID == accountID },
      sortBy: [SortDescriptor(\.createdAt)]
    )
    return try context.fetch(descriptor).map { record in
      let upload = try? decoder.decode(PendingPhotoUpload.self, from: record.payload)
      return PendingUploadEntry(
        id: record.id,
        accountID: record.accountID,
        createdAt: record.createdAt,
        locationName: record.locationName,
        upload: upload,
        lastError: upload == nil ? "This saved upload is unreadable." : record.lastError,
        requiresAttention: upload == nil || record.requiresAttention,
        awaitingReconciliation: record.awaitingReconciliation
      )
    }
  }

  func enqueue(_ upload: PendingPhotoUpload) throws {
    let context = ModelContext(container)
    let uploadID = upload.id
    let descriptor = FetchDescriptor<PendingUploadRecord>(
      predicate: #Predicate { $0.id == uploadID }
    )
    let payload = try encoder.encode(upload)
    if let record = try context.fetch(descriptor).first {
      guard record.accountID == upload.accountID else {
        throw PendingUploadStoreError.identifierConflict
      }
      record.createdAt = upload.createdAt
      record.locationName = upload.locationName
      record.payload = payload
      record.lastError = nil
      record.requiresAttention = false
    } else {
      context.insert(
        PendingUploadRecord(
          id: upload.id,
          accountID: upload.accountID,
          createdAt: upload.createdAt,
          locationName: upload.locationName,
          payload: payload
        ))
    }
    try context.save()
  }

  func markFailed(
    id: String,
    accountID: String,
    message: String,
    requiresAttention: Bool,
    awaitingReconciliation: Bool
  ) throws {
    let context = ModelContext(container)
    guard let record = try record(id: id, accountID: accountID, context: context) else { return }
    record.lastError = message
    record.requiresAttention = requiresAttention
    record.awaitingReconciliation = awaitingReconciliation
    try context.save()
  }

  func markAwaitingReconciliation(id: String, accountID: String) throws {
    let context = ModelContext(container)
    guard let record = try record(id: id, accountID: accountID, context: context) else { return }
    record.awaitingReconciliation = true
    try context.save()
  }

  func remove(id: String, accountID: String) throws {
    let context = ModelContext(container)
    guard let record = try record(id: id, accountID: accountID, context: context) else { return }
    context.delete(record)
    try context.save()
  }

  func clear(accountID: String) throws {
    let context = ModelContext(container)
    let descriptor = FetchDescriptor<PendingUploadRecord>(
      predicate: #Predicate { $0.accountID == accountID }
    )
    for record in try context.fetch(descriptor) {
      context.delete(record)
    }
    try context.save()
  }

  func reassign(from sourceAccountID: String, to targetAccountID: String) throws {
    guard sourceAccountID != targetAccountID else { return }
    let context = ModelContext(container)
    let descriptor = FetchDescriptor<PendingUploadRecord>(
      predicate: #Predicate { $0.accountID == sourceAccountID }
    )
    for record in try context.fetch(descriptor) {
      record.accountID = targetAccountID
      guard let upload = try? decoder.decode(PendingPhotoUpload.self, from: record.payload) else {
        continue
      }
      let reassignedOuting = (upload.outing ?? upload.outingRecoverySnapshot).map {
        Outing(
          id: $0.id,
          userId: targetAccountID,
          startTime: $0.startTime,
          endTime: $0.endTime,
          locationName: $0.locationName,
          defaultLocationName: $0.defaultLocationName,
          lat: $0.lat,
          lon: $0.lon,
          stateProvince: $0.stateProvince,
          countryCode: $0.countryCode,
          protocol: $0.protocol,
          numberObservers: $0.numberObservers,
          allObsReported: $0.allObsReported,
          effortDistanceMiles: $0.effortDistanceMiles,
          effortAreaAcres: $0.effortAreaAcres,
          notes: $0.notes,
          createdAt: $0.createdAt
        )
      }
      record.payload = try encoder.encode(
        PendingPhotoUpload(
          id: upload.id,
          accountID: targetAccountID,
          createdAt: upload.createdAt,
          locationName: upload.locationName,
          outing: reassignedOuting,
          outingRecoverySnapshot: nil,
          photos: upload.photos,
          observations: upload.observations
        ))
    }
    try context.save()
  }

  private func record(
    id: String,
    accountID: String,
    context: ModelContext
  ) throws -> PendingUploadRecord? {
    let recordID = id
    let ownerID = accountID
    let descriptor = FetchDescriptor<PendingUploadRecord>(
      predicate: #Predicate { $0.id == recordID && $0.accountID == ownerID }
    )
    return try context.fetch(descriptor).first
  }

  private static func defaultStoreURL() throws -> URL {
    let directory = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    ).appending(path: "WingDexPendingUploads", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appending(path: "WingDexPendingUploads.store")
  }
}

private enum PendingUploadStoreError: Error {
  case identifierConflict
}

@Model
private final class PendingUploadRecord {
  @Attribute(.unique) var id: String
  var accountID: String
  var createdAt: Date
  var locationName: String
  @Attribute(.externalStorage) var payload: Data
  var lastError: String?
  var requiresAttention: Bool
  var awaitingReconciliation: Bool = false

  init(
    id: String,
    accountID: String,
    createdAt: Date,
    locationName: String,
    payload: Data,
    lastError: String? = nil,
    requiresAttention: Bool = false,
    awaitingReconciliation: Bool = false
  ) {
    self.id = id
    self.accountID = accountID
    self.createdAt = createdAt
    self.locationName = locationName
    self.payload = payload
    self.lastError = lastError
    self.requiresAttention = requiresAttention
    self.awaitingReconciliation = awaitingReconciliation
  }
}
