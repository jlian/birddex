import SwiftUI

struct CachedDataNotice: View {
    @Environment(DataStore.self) private var store
  @State private var showingPendingUploads = false

    var body: some View {
    if store.pendingUploadStoreUnavailable {
      Label("Saved uploads unavailable - restart WingDex", systemImage: "exclamationmark.triangle")
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(.bar)
        .accessibilityIdentifier("pending-upload-store-unavailable")
    } else if store.pendingUploadCount > 0 {
      Button {
        showingPendingUploads = true
      } label: {
        Label(pendingText, systemImage: pendingIcon)
          .font(.footnote.weight(.medium))
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
          .background(.bar)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("pending-upload-notice")
      .sheet(isPresented: $showingPendingUploads) {
        PendingUploadsView()
      }
    } else if store.isShowingCachedData {
            Label("Offline data - reconnect to make changes", systemImage: "wifi.slash")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(.bar)
                .accessibilityIdentifier("cached-data-notice")
        }
    }

  private var pendingText: String {
    if store.isSyncingPendingUploads {
      return "Syncing saved uploads..."
    }
    if store.pendingUploadSafetyBlocked {
      return "\(uploadCountText) paused after an unconfirmed deletion"
    }
    if store.pendingUploadsNeedAttention {
      return "\(uploadCountText) \(store.pendingUploadCount == 1 ? "needs" : "need") attention"
    }
    if store.isShowingCachedData || store.pendingUploadError == .offline {
      return "Offline - \(uploadCountText) saved on this device"
    }
    return "\(uploadCountText) waiting to sync"
  }

  private var pendingIcon: String {
    if store.isSyncingPendingUploads { return "arrow.trianglehead.2.clockwise.rotate.90" }
    if store.pendingUploadsNeedAttention { return "exclamationmark.triangle" }
    return "icloud.and.arrow.up"
  }

  private var uploadCountText: String {
    "\(store.pendingUploadCount) upload\(store.pendingUploadCount == 1 ? "" : "s")"
  }
}