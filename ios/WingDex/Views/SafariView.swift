import SafariServices
import SwiftUI

/// A URL wrapped for `.fullScreenCover(item:)`.
struct SafariLink: Identifiable, Hashable {
    let url: URL

    var id: URL { url }

    /// Nil for anything that is not http(s). `SFSafariViewController` raises
    /// NSInvalidArgumentException on other schemes, so the check belongs here
    /// rather than at each call site.
    init?(url: URL) {
        switch url.scheme?.lowercased() {
        case "http", "https": break
        default: return nil
        }
        self.url = url
    }
}

/// `SFSafariViewController` in SwiftUI, so a reference link opens over the app
/// rather than throwing the user out of a half-finished identification.
struct SafariView: UIViewControllerRepresentable {
    let link: SafariLink

    func makeUIViewController(context: Context) -> SFSafariViewController {
        // No bar or control tint: iOS 26 deprecated both because they interfere
        // with the background effects the system already applies.
        let controller = SFSafariViewController(url: link.url)
        controller.dismissButtonStyle = .done
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
