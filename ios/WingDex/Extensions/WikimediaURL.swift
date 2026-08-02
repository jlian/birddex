import Foundation

/// Wikimedia renders thumbnails only at the widths in `$wgThumbnailSteps`, and rejects
/// direct requests for any other width. 960 is the step that covers a 280pt hero at 3x.
/// https://www.mediawiki.org/wiki/Common_thumbnail_sizes
private let heroThumbnailStep = 960

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
    guard let thumbnailUrl,
          thumbnailUrl.contains("/thumb/"),
          let lastSlash = thumbnailUrl.lastIndex(of: "/")
    else { return nil }

    let filename = thumbnailUrl[thumbnailUrl.index(after: lastSlash)...]
    guard let width = filename.range(of: #"[0-9]+px-"#, options: .regularExpression) else {
        return nil
    }
    return thumbnailUrl.replacingCharacters(in: width, with: "\(heroThumbnailStep)px-")
}
