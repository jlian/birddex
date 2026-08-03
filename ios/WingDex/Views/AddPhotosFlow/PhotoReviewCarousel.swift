import SwiftUI
import UIKit

struct PhotoReviewCarousel: UIViewRepresentable {
    let photos: [ProcessedPhoto]
    let onRemove: (ProcessedPhoto) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(photos: photos, onRemove: onRemove)
    }

    func makeUIView(context: Context) -> UICollectionView {
        let layout = UICollectionViewFlowLayout()
        layout.scrollDirection = .horizontal
        layout.minimumLineSpacing = 8
        layout.minimumInteritemSpacing = 8
        layout.itemSize = CGSize(width: 150, height: 150)

        let collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.backgroundColor = .clear
        collectionView.showsHorizontalScrollIndicator = false
        collectionView.alwaysBounceHorizontal = true
        collectionView.delaysContentTouches = false
        collectionView.canCancelContentTouches = true
        collectionView.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "PhotoReviewCell")
        collectionView.dataSource = context.coordinator
        collectionView.delegate = context.coordinator
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        let oldIDs = context.coordinator.photos.map(\.id)
        context.coordinator.photos = photos
        context.coordinator.onRemove = onRemove
        if oldIDs != photos.map(\.id) { collectionView.reloadData() }
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
        var photos: [ProcessedPhoto]
        var onRemove: (ProcessedPhoto) -> Void

        init(photos: [ProcessedPhoto], onRemove: @escaping (ProcessedPhoto) -> Void) {
            self.photos = photos
            self.onRemove = onRemove
        }

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            photos.count
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cellForItemAt indexPath: IndexPath
        ) -> UICollectionViewCell {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "PhotoReviewCell", for: indexPath)
            let photo = photos[indexPath.item]
            cell.contentConfiguration = UIHostingConfiguration {
                PhotoReviewThumbnail(data: photo.thumbnail)
            }
            .margins(.all, 0)
            cell.backgroundColor = .clear
            cell.contentView.backgroundColor = .clear
            cell.isAccessibilityElement = true
            cell.accessibilityLabel = "Bird photo"
            cell.accessibilityTraits = .image
            cell.accessibilityCustomActions = [
                UIAccessibilityCustomAction(name: "Remove Photo") { [weak self] _ in
                    self?.onRemove(photo)
                    return true
                },
            ]
            return cell
        }

        func collectionView(
            _ collectionView: UICollectionView,
            contextMenuConfigurationForItemAt indexPath: IndexPath,
            point: CGPoint
        ) -> UIContextMenuConfiguration? {
            let photo = photos[indexPath.item]
            return UIContextMenuConfiguration(
                identifier: photo.id as NSString,
                previewProvider: {
                    guard let image = UIImage(data: photo.image) else { return nil }
                    let size = Self.previewSize(for: image)
                    let controller = UIHostingController(
                        rootView: Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(width: size.width, height: size.height)
                            .clipped()
                    )
                    controller.view.backgroundColor = .clear
                    controller.preferredContentSize = size
                    return controller
                },
                actionProvider: { [weak self] _ in
                    UIMenu(children: [
                        UIAction(
                            title: "Remove Photo",
                            image: UIImage(systemName: "trash"),
                            attributes: .destructive
                        ) { _ in self?.onRemove(photo) },
                    ])
                }
            )
        }

        func collectionView(
            _ collectionView: UICollectionView,
            previewForHighlightingContextMenuWithConfiguration configuration: UIContextMenuConfiguration
        ) -> UITargetedPreview? {
            targetedPreview(for: configuration, in: collectionView)
        }

        func collectionView(
            _ collectionView: UICollectionView,
            previewForDismissingContextMenuWithConfiguration configuration: UIContextMenuConfiguration
        ) -> UITargetedPreview? {
            targetedPreview(for: configuration, in: collectionView)
        }

        private func targetedPreview(
            for configuration: UIContextMenuConfiguration,
            in collectionView: UICollectionView
        ) -> UITargetedPreview? {
            guard let id = configuration.identifier as? String,
                  let index = photos.firstIndex(where: { $0.id == id }),
                  let cell = collectionView.cellForItem(at: IndexPath(item: index, section: 0))
            else { return nil }
            let parameters = UIPreviewParameters()
            parameters.backgroundColor = .clear
            parameters.visiblePath = UIBezierPath(roundedRect: cell.bounds, cornerRadius: 8)
            return UITargetedPreview(view: cell, parameters: parameters)
        }

        private static func previewSize(for image: UIImage) -> CGSize {
            let maxWidth: CGFloat = 360
            let maxHeight: CGFloat = 560
            let aspect = max(image.size.width, 1) / max(image.size.height, 1)
            var width = maxWidth
            var height = width / aspect
            if height > maxHeight {
                height = maxHeight
                width = height * aspect
            }
            return CGSize(width: max(180, width), height: max(180, height))
        }
    }
}

private struct PhotoReviewThumbnail: View {
    let data: Data

    var body: some View {
        Group {
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.1))
                    .overlay {
                        Image(systemName: "photo")
                            .foregroundStyle(.tertiary)
                    }
            }
        }
        .frame(width: 150, height: 150)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
