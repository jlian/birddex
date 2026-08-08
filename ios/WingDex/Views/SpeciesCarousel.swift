import SwiftUI
import UIKit

struct ContextMenuAccessibilityAction {
    let name: String
    let handler: () -> Void
}

struct SpeciesCarousel: UIViewRepresentable {
    let entries: [DexEntry]
    let store: DataStore
    let cardSize: CGFloat
    let menu: (DexEntry) -> UIMenu
    let accessibilityActions: (DexEntry) -> [ContextMenuAccessibilityAction]
    let onSelect: (DexEntry) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            entries: entries,
            store: store,
            cardSize: cardSize,
            menu: menu,
            accessibilityActions: accessibilityActions,
            onSelect: onSelect
        )
    }

    func makeUIView(context: Context) -> UICollectionView {
        let layout = UICollectionViewFlowLayout()
        layout.scrollDirection = .horizontal
        layout.minimumLineSpacing = 10
        layout.minimumInteritemSpacing = 10
        layout.sectionInset = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
        layout.itemSize = CGSize(width: cardSize, height: cardSize)

        let collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.backgroundColor = .clear
        collectionView.showsHorizontalScrollIndicator = false
        collectionView.alwaysBounceHorizontal = true
        collectionView.delaysContentTouches = false
        collectionView.canCancelContentTouches = true
        collectionView.register(SpeciesCarouselCell.self, forCellWithReuseIdentifier: SpeciesCarouselCell.reuseIdentifier)
        collectionView.dataSource = context.coordinator
        collectionView.delegate = context.coordinator
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        let coordinator = context.coordinator
        let needsReload = coordinator.entries != entries || coordinator.cardSize != cardSize
        coordinator.update(
            entries: entries,
            store: store,
            cardSize: cardSize,
            menu: menu,
            accessibilityActions: accessibilityActions,
            onSelect: onSelect
        )

        if let layout = collectionView.collectionViewLayout as? UICollectionViewFlowLayout,
           layout.itemSize != CGSize(width: cardSize, height: cardSize) {
            layout.itemSize = CGSize(width: cardSize, height: cardSize)
            layout.invalidateLayout()
        }
        if needsReload { collectionView.reloadData() }
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
        var entries: [DexEntry]
        var store: DataStore
        var cardSize: CGFloat
        var menu: (DexEntry) -> UIMenu
        var accessibilityActions: (DexEntry) -> [ContextMenuAccessibilityAction]
        var onSelect: (DexEntry) -> Void

        init(
            entries: [DexEntry],
            store: DataStore,
            cardSize: CGFloat,
            menu: @escaping (DexEntry) -> UIMenu,
            accessibilityActions: @escaping (DexEntry) -> [ContextMenuAccessibilityAction],
            onSelect: @escaping (DexEntry) -> Void
        ) {
            self.entries = entries
            self.store = store
            self.cardSize = cardSize
            self.menu = menu
            self.accessibilityActions = accessibilityActions
            self.onSelect = onSelect
        }

        func update(
            entries: [DexEntry],
            store: DataStore,
            cardSize: CGFloat,
            menu: @escaping (DexEntry) -> UIMenu,
            accessibilityActions: @escaping (DexEntry) -> [ContextMenuAccessibilityAction],
            onSelect: @escaping (DexEntry) -> Void
        ) {
            self.entries = entries
            self.store = store
            self.cardSize = cardSize
            self.menu = menu
            self.accessibilityActions = accessibilityActions
            self.onSelect = onSelect
        }

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            entries.count
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cellForItemAt indexPath: IndexPath
        ) -> UICollectionViewCell {
            let cell = collectionView.dequeueReusableCell(
                withReuseIdentifier: SpeciesCarouselCell.reuseIdentifier,
                for: indexPath
            ) as! SpeciesCarouselCell
            let entry = entries[indexPath.item]
            cell.contentConfiguration = UIHostingConfiguration {
                SpeciesCard(entry: entry, size: cardSize)
            }
            .margins(.all, 0)
            cell.speciesName = getDisplayName(entry.speciesName)
            cell.accessibilityCustomActions = accessibilityActions(entry).map { action in
                UIAccessibilityCustomAction(name: action.name) { _ in
                    action.handler()
                    return true
                }
            }
            cell.onAccessibilityActivate = { [weak self] in self?.onSelect(entry) }
            return cell
        }

        func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
            onSelect(entries[indexPath.item])
        }

        func collectionView(
            _ collectionView: UICollectionView,
            contextMenuConfigurationForItemAt indexPath: IndexPath,
            point: CGPoint
        ) -> UIContextMenuConfiguration? {
            let entry = entries[indexPath.item]
            return UIContextMenuConfiguration(
                identifier: entry.id as NSString,
                previewProvider: { [weak self] in
                    guard let self else { return nil }
                    let controller = UIHostingController(
                        rootView: NavigationStack {
                            SpeciesDetailView(speciesName: entry.speciesName)
                        }
                        .environment(self.store)
                    )
                    controller.view.backgroundColor = .clear
                    controller.sizingOptions = [.preferredContentSize]
                    return controller
                },
                actionProvider: { [weak self] _ in self?.menu(entry) }
            )
        }

        func collectionView(
            _ collectionView: UICollectionView,
            willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration,
            animator: any UIContextMenuInteractionCommitAnimating
        ) {
            guard let entryId = configuration.identifier as? String,
                  let entry = entries.first(where: { $0.id == entryId })
            else { return }
            animator.preferredCommitStyle = .pop
            animator.addCompletion { [weak self] in self?.onSelect(entry) }
        }
    }
}

@MainActor
private final class SpeciesCarouselCell: UICollectionViewCell {
    static let reuseIdentifier = "SpeciesCarouselCell"
    var onAccessibilityActivate: (() -> Void)?
    var speciesName: String? {
        didSet {
            nameLabel.text = speciesName
            accessibilityLabel = speciesName
        }
    }

    private let captionView = UIView()
    private let nameLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        isAccessibilityElement = true
        accessibilityTraits = .button

        captionView.translatesAutoresizingMaskIntoConstraints = false
        captionView.backgroundColor = .black
        captionView.isAccessibilityElement = false
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.adjustsFontForContentSizeCategory = true
        nameLabel.font = .preferredFont(forTextStyle: .caption1)
        nameLabel.textColor = .white
        nameLabel.numberOfLines = 0
        nameLabel.isAccessibilityElement = false
        captionView.addSubview(nameLabel)
        contentView.addSubview(captionView)

        NSLayoutConstraint.activate([
            captionView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            captionView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            captionView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            captionView.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            nameLabel.leadingAnchor.constraint(equalTo: captionView.leadingAnchor, constant: 10),
            nameLabel.trailingAnchor.constraint(equalTo: captionView.trailingAnchor, constant: -10),
            nameLabel.topAnchor.constraint(equalTo: captionView.topAnchor, constant: 8),
            nameLabel.bottomAnchor.constraint(equalTo: captionView.bottomAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        contentView.bringSubviewToFront(captionView)
    }

    override var isHighlighted: Bool {
        didSet {
            if isHighlighted {
                contentView.alpha = 0.82
                contentView.transform = CGAffineTransform(scaleX: 0.97, y: 0.97)
            } else {
                UIView.animate(
                    withDuration: 0.15,
                    delay: 0,
                    options: [.beginFromCurrentState, .allowUserInteraction]
                ) {
                    self.contentView.alpha = 1
                    self.contentView.transform = .identity
                }
            }
        }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        contentView.alpha = 1
        contentView.transform = .identity
        speciesName = nil
        accessibilityCustomActions = nil
        onAccessibilityActivate = nil
    }

    override func accessibilityActivate() -> Bool {
        onAccessibilityActivate?()
        return true
    }
}
