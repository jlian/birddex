import AuthenticationServices
import SwiftUI

/// Displays the user's registered passkeys with options to add or remove them.
struct PasskeyManagementView: View {
    @Environment(AuthService.self) private var auth
    @Environment(ToastCenter.self) private var toasts
    @State private var passkeys: [PasskeyService.PasskeyInfo] = []
    @State private var isLoading = true
    @State private var errorMessage: AppError?
    @State private var showAddSheet = false
    @State private var newPasskeyName = ""
    @State private var isAdding = false
    @State private var deleteTarget: PasskeyService.PasskeyInfo?

    var body: some View {
        List {
            if isLoading {
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            } else if passkeys.isEmpty {
                ContentUnavailableView(
                    "No Passkeys",
                    systemImage: "person.badge.key.fill",
                    description: Text("Add a passkey for quick, secure sign-in without a password.")
                )
            } else {
                Section {
                    ForEach(passkeys) { passkey in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(passkey.name ?? "Passkey")
                                    .font(.body)
                                if let dateString = formatDate(passkey.createdAt) {
                                    Text("Added \(dateString)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Button(role: .destructive) {
                                deleteTarget = passkey
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.borderless)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                deleteTarget = passkey
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text("Registered Passkeys")
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage.message)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }
        }
        .navigationTitle("Passkeys")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add", systemImage: "plus") {
                    newPasskeyName = Self.defaultPasskeyName(displayName: auth.userName)
                    showAddSheet = true
                }
                .disabled(isAdding)
            }
        }
        .task {
            await loadPasskeys()
        }
        .alert("Add Passkey", isPresented: $showAddSheet) {
            TextField("Passkey Name", text: $newPasskeyName)
            Button("Cancel", role: .cancel) {}
            Button("Add") {
                Task { await addPasskey() }
            }
        } message: {
            Text("Give this passkey a name to help identify it later.")
        }
        .alert("Delete Passkey?", isPresented: Binding(
            get: { deleteTarget != nil },
            set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                if let target = deleteTarget {
                    Task { await removePasskey(id: target.id) }
                }
            }
        } message: {
            Text("This passkey will be removed from your account. You can re-add it later.")
        }
    }

    // MARK: - Actions

    private func loadPasskeys() async {
        isLoading = true
        errorMessage = nil
        do {
            passkeys = try await auth.listPasskeys()
        } catch {
            errorMessage = AppError.map(error, fallback: "Could not load passkeys. Try again.")
        }
        isLoading = false
    }

    private func addPasskey() async {
        let name = newPasskeyName.trimmingCharacters(in: .whitespacesAndNewlines)
        isAdding = true
        errorMessage = nil
        do {
            let finalName = name.isEmpty ? Self.defaultPasskeyName(displayName: auth.userName) : name
            try await auth.registerPasskey(name: finalName)
            await loadPasskeys()
            toasts.show("Passkey added")
        } catch {
            errorMessage = AppError.map(error, fallback: "Could not add this passkey. Try again.")
        }
        isAdding = false
    }

    /// Generate a default passkey name matching the web app's pattern: "Device (DisplayName)".
    /// Web uses buildPasskeyName() from passkey-label.ts.
    private static func defaultPasskeyName(displayName: String? = nil) -> String {
        var deviceName = "iPhone"
        #if targetEnvironment(simulator)
        deviceName = "Simulator"
        #else
        let model = UIDevice.current.model
        if model.contains("iPad") {
            deviceName = "iPad"
        }
        #endif
        let name = (displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            return deviceName
        }
        return "\(deviceName) (\(name))"
    }

    private func removePasskey(id: String) async {
        errorMessage = nil
        do {
            try await auth.deletePasskey(id: id)
            passkeys.removeAll { $0.id == id }
            toasts.show("Passkey removed")
        } catch {
            errorMessage = AppError.map(error, fallback: "Could not delete this passkey. Try again.")
        }
    }

    // MARK: - Helpers

    private func formatDate(_ isoString: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString)
                ?? ISO8601DateFormatter().date(from: isoString)
        else { return nil }
        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .none
        return display.string(from: date)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        PasskeyManagementView()
            .environment(AuthService())
            .environment(ToastCenter())
    }
}
#endif
