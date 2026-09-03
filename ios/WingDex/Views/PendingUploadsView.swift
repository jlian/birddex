import SwiftUI

struct PendingUploadsView: View {
  @Environment(DataStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var pendingDiscard: PendingUploadEntry?
  @State private var showingDiscardConfirmation = false
  @State private var discardError: AppError?

  var body: some View {
    NavigationStack {
      Group {
        if store.pendingUploads.isEmpty {
          ContentUnavailableView(
            "Everything is synced",
            systemImage: "checkmark.icloud",
            description: Text(
              "Saved sightings will appear in WingDex after the server confirms them.")
          )
        } else {
          List(store.pendingUploads) { entry in
            VStack(alignment: .leading, spacing: 6) {
              Text(entry.locationName.isEmpty ? "Unknown Location" : entry.locationName)
                .font(.headline)
              Text(entry.createdAt, format: .dateTime.month().day().hour().minute())
                .font(.subheadline)
                .foregroundStyle(.secondary)
              if let lastError = entry.lastError {
                Label(
                  lastError,
                  systemImage: entry.requiresAttention
                    ? "exclamationmark.triangle"
                    : "wifi.slash"
                )
                .font(.caption)
                .foregroundStyle(entry.requiresAttention ? .orange : .secondary)
              }
              Button("Discard Saved Upload", role: .destructive) {
                pendingDiscard = entry
                showingDiscardConfirmation = true
              }
              .font(.subheadline)
              .disabled(store.isPendingUploadInFlight(id: entry.id))
            }
            .padding(.vertical, 4)
          }
        }
      }
      .navigationTitle("Saved Uploads")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .primaryAction) {
          Button("Retry") {
            Task { await store.syncPendingUploads(retryAttention: true) }
          }
          .disabled(
            !store.hasSyncablePendingUploads
              || store.isSyncingPendingUploads
              || store.pendingUploadSafetyBlocked
          )
        }
      }
      .confirmationDialog(
        "Discard this saved upload?",
        isPresented: $showingDiscardConfirmation,
        presenting: pendingDiscard
      ) { entry in
        Button("Discard Upload", role: .destructive) {
          Task {
            do {
              try await store.discardPendingUpload(id: entry.id)
              pendingDiscard = nil
            } catch {
              discardError = AppError.map(
                error,
                fallback: "WingDex couldn't discard this saved upload."
              )
            }
          }
        }
        Button("Cancel", role: .cancel) {
          pendingDiscard = nil
        }
      } message: { entry in
        Text(
          "The sightings from \(entry.locationName.isEmpty ? "this outing" : entry.locationName) have not reached WingDex and cannot be recovered after you discard them."
        )
      }
      .alert(item: $discardError) { error in
        Alert(
          title: Text("Could Not Discard Upload"),
          message: Text(error.message),
          dismissButton: .cancel()
        )
      }
    }
  }
}
