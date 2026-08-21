import Foundation
import UIKit
import Capacitor
import UniformTypeIdentifiers

private final class KmlActivityItemSource: NSObject, UIActivityItemSource {
    private let fileURL: URL
    private let title: String
    private let typeIdentifier: String

    init(fileURL: URL, title: String) {
        self.fileURL = fileURL
        self.title = title
        self.typeIdentifier = fileURL.pathExtension.lowercased() == "kmz" ? "com.google.earth.kmz" : "com.google.earth.kml"
        super.init()
    }

    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        return fileURL
    }

    func activityViewController(_ activityViewController: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        return fileURL
    }

    func activityViewController(_ activityViewController: UIActivityViewController, subjectForActivityType activityType: UIActivity.ActivityType?) -> String {
        return title
    }

    func activityViewController(_ activityViewController: UIActivityViewController, dataTypeIdentifierForActivityType activityType: UIActivity.ActivityType?) -> String {
        return typeIdentifier
    }
}

@objc(EarthSharePlugin)
public class EarthSharePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentInteractionControllerDelegate, UIDocumentPickerDelegate {
    public let identifier = "EarthSharePlugin"
    public let jsName = "EarthShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isGoogleEarthInstalled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openGoogleEarth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openGoogleEarthStore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareKml", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFileToFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickWaypointFile", returnType: CAPPluginReturnPromise)
    ]
    private var activityItemSource: KmlActivityItemSource?
    private var documentController: UIDocumentInteractionController?
    private var pendingDocumentPickerCall: CAPPluginCall?
    private var pendingExportURL: URL?
    private var pendingImportCall: CAPPluginCall?

    @objc func isGoogleEarthInstalled(_ call: CAPPluginCall) {
        call.resolve(["installed": isGoogleEarthAvailable()])
    }

    @objc func openGoogleEarth(_ call: CAPPluginCall) {
        let urls = ["comgoogleearth://", "comgoogleearth-x-callback://"].compactMap { URL(string: $0) }
        guard let url = urls.first(where: { UIApplication.shared.canOpenURL($0) }) else {
            call.reject("GOOGLE_EARTH_NOT_INSTALLED")
            return
        }

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { completed in
                if completed {
                    call.resolve(["opened": true])
                } else {
                    call.reject("GOOGLE_EARTH_OPEN_FAILED")
                }
            }
        }
    }

    @objc func openGoogleEarthStore(_ call: CAPPluginCall) {
        let urls = [
            URL(string: "itms-apps://itunes.apple.com/app/id293622097"),
            URL(string: "https://apps.apple.com/app/google-earth/id293622097")
        ].compactMap { $0 }

        DispatchQueue.main.async {
            self.openFirstAvailableUrl(urls, call: call)
        }
    }

    @objc func shareKml(_ call: CAPPluginCall) {
        guard let rawFilename = call.getString("filename"), !rawFilename.isEmpty else {
            call.reject("Missing filename")
            return
        }

        guard let content = call.getString("content"), !content.isEmpty else {
            call.reject("Missing KML content")
            return
        }

        var filename = safeFilename(rawFilename, fallback: "frentes-productivos.kml")
        if !filename.lowercased().hasSuffix(".kml") && !filename.lowercased().hasSuffix(".kmz") {
            filename += ".kml"
        }
        let title = call.getString("title") ?? "Abrir en Google Earth"

        do {
            let documents = try FileManager.default.url(
                for: .documentDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            let fileURL = documents.appendingPathComponent(filename, isDirectory: false)
            guard let data = content.data(using: .utf8) else {
                call.reject("KML content is not UTF-8")
                return
            }
            try data.write(to: fileURL, options: [.atomic])

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                guard self.isGoogleEarthAvailable() else {
                    call.reject("GOOGLE_EARTH_NOT_INSTALLED")
                    return
                }
                self.presentOpenInMenu(fileURL: fileURL, title: title, call: call)
            }
        } catch {
            call.reject("Could not write KML file", nil, error)
        }
    }

    @objc func saveFileToFiles(_ call: CAPPluginCall) {
        guard pendingDocumentPickerCall == nil else {
            call.reject("Otra exportación sigue abierta")
            return
        }

        guard let rawFilename = call.getString("filename"), !rawFilename.isEmpty else {
            call.reject("Missing filename")
            return
        }

        guard let content = call.getString("content"), !content.isEmpty else {
            call.reject("Missing file content")
            return
        }

        let filename = safeFilename(rawFilename, fallback: "hotspot-export.geojson")

        do {
            let exportsDirectory = FileManager.default.temporaryDirectory
                .appendingPathComponent("HotspotFishingExports", isDirectory: true)
            try FileManager.default.createDirectory(
                at: exportsDirectory,
                withIntermediateDirectories: true,
                attributes: nil
            )
            let fileURL = exportsDirectory.appendingPathComponent(filename, isDirectory: false)
            guard let data = content.data(using: .utf8) else {
                call.reject("File content is not UTF-8")
                return
            }
            try data.write(to: fileURL, options: [.atomic])

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.presentFilesExporter(fileURL: fileURL, call: call)
            }
        } catch {
            call.reject("Could not prepare file export", nil, error)
        }
    }

    @objc func shareFile(_ call: CAPPluginCall) {
        guard let rawFilename = call.getString("filename"), !rawFilename.isEmpty else {
            call.reject("Missing filename")
            return
        }
        guard let content = call.getString("content"), !content.isEmpty else {
            call.reject("Missing file content")
            return
        }

        let filename = safeFilename(rawFilename, fallback: "waypoints-hotspot-fishing.gpx")
        let title = call.getString("title") ?? "Compartir archivo"

        do {
            let exportDirectory = FileManager.default.temporaryDirectory
                .appendingPathComponent("HotspotFishingShare", isDirectory: true)
            try FileManager.default.createDirectory(
                at: exportDirectory,
                withIntermediateDirectories: true,
                attributes: nil
            )
            let fileURL = exportDirectory.appendingPathComponent(filename, isDirectory: false)
            guard let data = content.data(using: .utf8) else {
                call.reject("File content is not UTF-8")
                return
            }
            try data.write(to: fileURL, options: [.atomic])

            DispatchQueue.main.async { [weak self] in
                self?.presentGenericShareSheet(fileURL: fileURL, title: title, call: call)
            }
        } catch {
            call.reject("Could not prepare shared file", nil, error)
        }
    }

    @objc func pickWaypointFile(_ call: CAPPluginCall) {
        guard pendingImportCall == nil && pendingDocumentPickerCall == nil else {
            call.reject("Otro selector de archivos sigue abierto")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.presenterViewController() else {
                call.reject("No view controller available")
                return
            }

            let types: [UTType] = [
                UTType(filenameExtension: "gpx") ?? .xml,
                UTType(filenameExtension: "kml") ?? .xml,
                .xml,
                .plainText
            ]
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.pendingImportCall = call

            if let popover = picker.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            presenter.present(picker, animated: true)
        }
    }

    private func presentOpenInMenu(fileURL: URL, title: String, call: CAPPluginCall) {
        guard let presenter = presenterViewController() else {
            call.reject("No view controller available")
            return
        }

        let rect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.midY,
            width: 1,
            height: 1
        )

        let controller = UIDocumentInteractionController(url: fileURL)
        controller.delegate = self
        if #available(iOS 14.0, *) {
            controller.name = title
        }
        controller.uti = fileURL.pathExtension.lowercased() == "kmz" ? "com.google.earth.kmz" : "com.google.earth.kml"
        self.documentController = controller

        let show = { [weak self] in
            guard let self = self else { return }
            let didShow = controller.presentOpenInMenu(from: rect, in: presenter.view, animated: true)
            if didShow {
                call.resolve(["activityType": "documentInteractionOpenInMenu"])
            } else {
                self.documentController = nil
                self.presentShareSheet(fileURL: fileURL, title: title, call: call)
            }
        }

        if let presented = presenter.presentedViewController {
            presented.dismiss(animated: false) {
                show()
            }
        } else {
            show()
        }
    }

    private func presentShareSheet(fileURL: URL, title: String, call: CAPPluginCall) {
        guard let presenter = presenterViewController() else {
            call.reject("No view controller available")
            return
        }

        let rect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.midY,
            width: 1,
            height: 1
        )

        let itemSource = KmlActivityItemSource(fileURL: fileURL, title: title)
        activityItemSource = itemSource
        let activityController = UIActivityViewController(activityItems: [itemSource], applicationActivities: nil)
        activityController.setValue(title, forKey: "subject")

        if let popover = activityController.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = rect
            popover.permittedArrowDirections = []
        }

        activityController.completionWithItemsHandler = { [weak self] activityType, completed, _, error in
            self?.activityItemSource = nil
            if let error = error {
                call.reject("Error sharing KML", nil, error)
                return
            }

            if completed {
                call.resolve(["activityType": activityType?.rawValue ?? "activityViewController"])
            } else {
                call.reject("Share canceled")
            }
        }

        let show = {
            presenter.present(activityController, animated: true) {
                // La promesa se resuelve/cancela al elegir destino. Así evitamos
                // el falso "éxito" donde iOS decía abrir el menú pero no mostraba nada.
            }
        }

        if let presented = presenter.presentedViewController {
            presented.dismiss(animated: false) {
                show()
            }
        } else {
            show()
        }
    }

    private func presentFilesExporter(fileURL: URL, call: CAPPluginCall) {
        guard let presenter = presenterViewController() else {
            call.reject("No view controller available")
            return
        }

        pendingDocumentPickerCall = call
        pendingExportURL = fileURL

        let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false

        if let popover = picker.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(
                x: presenter.view.bounds.midX,
                y: presenter.view.bounds.midY,
                width: 1,
                height: 1
            )
            popover.permittedArrowDirections = []
        }

        let show = { [weak presenter] in
            presenter?.present(picker, animated: true)
        }

        if let presented = presenter.presentedViewController {
            presented.dismiss(animated: false) {
                show()
            }
        } else {
            show()
        }
    }

    private func presentGenericShareSheet(fileURL: URL, title: String, call: CAPPluginCall) {
        guard let presenter = presenterViewController() else {
            call.reject("No view controller available")
            return
        }

        let controller = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        controller.setValue(title, forKey: "subject")
        if let popover = controller.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        controller.completionWithItemsHandler = { activityType, completed, _, error in
            if let error = error {
                call.reject("Error sharing file", nil, error)
            } else if completed {
                call.resolve(["activityType": activityType?.rawValue ?? "activityViewController"])
            } else {
                call.reject("Share canceled")
            }
        }

        let show = { presenter.present(controller, animated: true) }
        if let presented = presenter.presentedViewController {
            presented.dismiss(animated: false) { show() }
        } else {
            show()
        }
    }

    private func presenterViewController() -> UIViewController? {
        if let controller = baseViewController(from: bridge?.viewController), controller.viewIfLoaded?.window != nil {
            return controller
        }

        let keyWindow = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }

        return baseViewController(from: keyWindow?.rootViewController)
    }

    private func baseViewController(from root: UIViewController?) -> UIViewController? {
        if let nav = root as? UINavigationController {
            return baseViewController(from: nav.visibleViewController)
        }
        if let tab = root as? UITabBarController {
            return baseViewController(from: tab.selectedViewController)
        }
        return root
    }

    private func isGoogleEarthAvailable() -> Bool {
        let schemes = ["comgoogleearth://", "comgoogleearth-x-callback://"]
        return schemes.compactMap { URL(string: $0) }.contains { UIApplication.shared.canOpenURL($0) }
    }

    private func openFirstAvailableUrl(_ urls: [URL], call: CAPPluginCall) {
        guard let url = urls.first else {
            call.reject("APP_STORE_OPEN_FAILED")
            return
        }

        UIApplication.shared.open(url, options: [:]) { completed in
            if completed {
                call.resolve(["opened": true])
            } else {
                self.openFirstAvailableUrl(Array(urls.dropFirst()), call: call)
            }
        }
    }

    public func documentInteractionControllerDidDismissOpenInMenu(_ controller: UIDocumentInteractionController) {
        if controller === documentController {
            documentController = nil
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if let importCall = pendingImportCall {
            pendingImportCall = nil
            guard let url = urls.first else {
                importCall.reject("No file selected")
                return
            }
            let accessing = url.startAccessingSecurityScopedResource()
            defer {
                if accessing { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url, options: [.mappedIfSafe])
                guard data.count <= 20 * 1024 * 1024 else {
                    importCall.reject("File is too large")
                    return
                }
                guard let content = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
                    importCall.reject("File is not readable text")
                    return
                }
                importCall.resolve(["filename": url.lastPathComponent, "content": content])
            } catch {
                importCall.reject("Could not read selected file", nil, error)
            }
            return
        }

        let picked = urls.map { $0.absoluteString }
        pendingDocumentPickerCall?.resolve([
            "saved": true,
            "urls": picked,
            "filename": pendingExportURL?.lastPathComponent ?? ""
        ])
        pendingDocumentPickerCall = nil
        pendingExportURL = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if let importCall = pendingImportCall {
            pendingImportCall = nil
            importCall.reject("Import canceled")
            return
        }
        pendingDocumentPickerCall?.reject("Save canceled")
        pendingDocumentPickerCall = nil
        pendingExportURL = nil
    }

    private func safeFilename(_ value: String, fallback: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        let cleanedScalars = value.unicodeScalars
            .map { allowed.contains($0) ? String($0) : "-" }
            .joined()
        var cleaned = cleanedScalars
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))

        if cleaned.isEmpty {
            cleaned = fallback
        }
        return cleaned
    }
}
