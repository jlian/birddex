import SwiftUI

/// Two-option data management page: "Delete All Data" and "Delete Account & All Data".
/// Reached via NavigationLink from SettingsView.
struct DataManagementView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var showingDeleteDataConfirmation = false
    @State private var showingDeleteAccountStep1 = false
    @State private var showingDeleteAccountStep2 = false
    @State private var isDeleting = false
    @State private var deleteError: AppError?
    @State private var showingManualAppleRevocation = false

    var body: some View {
        Form {
            // Delete All Data
            Section {
                Button("Delete All Data") {
                    showingDeleteDataConfirmation = true
                }
                .foregroundStyle(Color.foregroundText)
            } footer: {
                Text("Removes all your outings, observations, and species data. Your account and login credentials are kept.")
                    .font(.footnote)
                    .foregroundStyle(Color.mutedText)
            }

            // Delete Account & All Data (two-stage)
            if auth.userId != nil {
                Section {
                    Button("Delete Account & All Data") {
                        showingDeleteAccountStep1 = true
                    }
                    .foregroundStyle(Color.foregroundText)
                    .disabled(isDeleting)
                    .alert(
                        "Delete your entire account?",
                        isPresented: $showingDeleteAccountStep1
                    ) {
                        Button("Cancel", role: .cancel) {}
                        Button("I understand, continue", role: .destructive) {
                            showingDeleteAccountStep2 = true
                        }
                    } message: {
                        Text("This is permanent and irreversible. The following will be deleted immediately:\n\n- All your outings and observations\n- Your entire WingDex species list\n- Your passkeys and login credentials\n- Your account and profile\n\nThere is no way to recover your data after this.")
                    }
                    .alert(
                        "Are you absolutely sure?",
                        isPresented: $showingDeleteAccountStep2
                    ) {
                        Button("Go back", role: .cancel) {}
                        Button("Delete my account forever", role: .destructive) {
                            Task { await deleteAccount() }
                        }
                    } message: {
                        Text("This will permanently delete your account and all associated data. You will be signed out immediately. This cannot be undone.")
                    }

                    if isDeleting {
                        HStack {
                            ProgressView()
                            Text("Deleting account...")
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let deleteError {
                        Text(deleteError.message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                } footer: {
                    Text("Permanently deletes your account, login credentials, passkeys, and all data. You will be signed out immediately.")
                        .font(.footnote)
                        .foregroundStyle(Color.mutedText)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.pageBg.ignoresSafeArea())
        .navigationTitle("Data Management")
        .navigationBarTitleDisplayMode(.inline)
        .alert(
            "Delete All Data?",
            isPresented: $showingDeleteDataConfirmation
        ) {
            Button("Cancel", role: .cancel) {}
            Button("Delete Everything", role: .destructive) {
                Task {
                    do {
                        try await store.clearAll()
                    } catch {
                        deleteError = AppError.map(error, fallback: "Could not delete your data. Try again.")
                    }
                }
            }
        } message: {
            Text("This will permanently delete all your outings, observations, and WingDex entries. This cannot be undone.")
        }
        .alert("One more Apple step", isPresented: $showingManualAppleRevocation) {
            Button("OK") { auth.signOut() }
        } message: {
            Text("Your WingDex account was deleted. Remove WingDex from Sign in with Apple in your Apple Account settings to revoke the remaining Apple access.")
        }
    }

    private func deleteAccount() async {
        isDeleting = true
        deleteError = nil
        do {
            let needsManualAppleRevocation = try await auth.deleteAccount()
            isDeleting = false
            if needsManualAppleRevocation {
                showingManualAppleRevocation = true
            } else {
                auth.signOut()
            }
        } catch {
            deleteError = AppError.map(error, fallback: "Could not delete your account. Try again.")
            isDeleting = false
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        DataManagementView()
            .environment(AuthService())
            .environment(previewStore())
    }
}
#endif
