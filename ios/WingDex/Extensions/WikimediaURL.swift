import Foundation

/// Wikimedia renders thumbnails only at the widths in `$wgThumbnailSteps`, and rejects
/// direct requests for any other width. 960 is the step that covers a 280pt hero at 3x, and
/// 500 the one that covers a ~150pt carousel card.
/// https://www.mediawiki.org/wiki/Common_thumbnail_sizes
private let heroThumbnailStep = 960
private let cardThumbnailStep = 500

/// Derive a hero-sized image URL from a dex thumbnail URL.
///
/// The rendered width lives in the last path component (`.../330px-Foo.jpg`, or
/// `.../lossy-page1-330px-Foo.tif.jpg` for multi-page sources), so the hero URL is known on
/// the same frame as the thumbnail with no network call. Wikimedia upscales past the
/// original width rather than failing, so every step resolves for every file.
///
/// Returns nil for originals served without a `/thumb/` segment, which have no rendered
/// variants and are already full size.
func heroImageUrl(fromThumbnail thumbnailUrl: String?) -> String? {
    resizedThumbnailUrl(thumbnailUrl, toStep: heroThumbnailStep)
}

/// Card-sized variant for the Home recent-species carousel, where the stored 330px render is
/// upscaled and visibly soft.
func cardImageUrl(fromThumbnail thumbnailUrl: String?) -> String? {
    resizedThumbnailUrl(thumbnailUrl, toStep: cardThumbnailStep)
}

private func resizedThumbnailUrl(_ thumbnailUrl: String?, toStep step: Int) -> String? {
    guard let thumbnailUrl,
          thumbnailUrl.contains("/thumb/"),
          let lastSlash = thumbnailUrl.lastIndex(of: "/")
    else { return nil }

    let filename = thumbnailUrl[thumbnailUrl.index(after: lastSlash)...]
    guard let width = filename.range(of: #"[0-9]+px-"#, options: .regularExpression) else {
        return nil
    }
    return thumbnailUrl.replacingCharacters(in: width, with: "\(step)px-")
}

/// Derive the file page URL from any upload.wikimedia.org image URL.
///
/// The file name is the segment before the rendered width for thumbnails
/// (`.../thumb/a/ab/Foo.jpg/330px-Foo.jpg`) and the last segment for originals
/// (`.../a/ab/Foo.jpg`). Most Commons photos are CC BY or CC BY-SA, and the file page
/// is where their credit and license notice live.
///
/// A few files are hosted on English Wikipedia rather than Commons, so the host comes
/// from the URL rather than being assumed.
func wikimediaFilePageUrl(fromImage imageUrl: String?) -> String? {
    guard let imageUrl else { return nil }
    let segments = imageUrl.split(separator: "/").map(String.init)
    let name = imageUrl.contains("/thumb/") ? segments.dropLast().last : segments.last
    guard let name, name.contains(".") else { return nil }

    let host: String
    if imageUrl.contains("/wikipedia/commons/") {
        host = "https://commons.wikimedia.org"
    } else if imageUrl.contains("/wikipedia/en/") {
        host = "https://en.wikipedia.org"
    } else {
        return nil
    }
    return "\(host)/wiki/File:\(name)"
}
