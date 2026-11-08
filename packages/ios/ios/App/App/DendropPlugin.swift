import Capacitor
import Foundation
import UIKit
import UserNotifications
import WebKit

/// The app's native calls, for two pages:
/// - the bundled setup page (www/index.html): choosing the server and turning notifications on;
/// - the Dendrop web client from your server: handing calls to iOS's call screen
///   (packages/web/src/native.ts). Everything else in the web client works as in Safari.
@objc(DendropPlugin)
public class DendropPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "DendropPlugin"
    public let jsName = "Dendrop"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enablePush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disablePush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nativeCalls", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "callState", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        // Not retained: an answer from before the page was listening is picked up with nativeCalls.
        CallManager.shared.emit = { [weak self] event, data in
            self?.notifyListeners(event, data: data, retainUntilConsumed: false)
        }
    }

    /// Only the setup page and the saved server may use the plugin, not a sign-in site that
    /// happens to be open in the app.
    private func trusted(_ call: CAPPluginCall) -> Bool {
        guard let url = webView?.url else { return false }
        let local = bridge?.config.localURL
        if url.scheme == local?.scheme && url.host == local?.host { return true }
        if let host = url.host?.lowercased(), host == ServerSettings.serverHost { return true }
        call.reject("Not allowed from this page")
        return false
    }

    // MARK: - Setup page

    /// Everything the setup page shows.
    @objc func getState(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        Task {
            let allowed = await PushRegistrar.notificationsAllowed()
            call.resolve([
                "platform": "ios",
                "serverUrl": ServerSettings.serverURL.map { $0 as Any } ?? NSNull(),
                "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
                "push": [
                    "enabled": PushRegistrar.isEnabled,
                    "notificationsAllowed": allowed,
                    "distributors": [String](),
                    "hasEndpoint": PushRegistrar.hasTokens,
                    "serverStatus": PushRegistrar.status,
                ] as [String: Any],
            ])
        }
    }

    /// Checks that a Dendrop server answers at the address and saves it.
    /// Rejects with a message the page can show when it doesn't.
    @objc func setServer(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        guard let url = ServerSettings.normalize(call.getString("url")) else {
            call.reject("That doesn't look like a web address. Try something like chat.example.com.")
            return
        }
        Task {
            if let problem = await Self.checkServer(url) {
                call.reject(problem)
                return
            }
            let changed = url != ServerSettings.serverURL
            ServerSettings.serverURL = url
            if changed { PushRegistrar.sync() }
            call.resolve(["serverUrl": url])
        }
    }

    /// Opens the saved server. Call after setServer, when the page is done.
    @objc func openServer(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        call.resolve()
        DispatchQueue.main.async {
            guard let server = ServerSettings.serverURL, let url = URL(string: server + "/") else { return }
            self.webView?.load(URLRequest(url: url))
        }
    }

    /// Asks for notification permission and registers with Apple for both kinds of push.
    @objc func enablePush(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        Task {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else {
                call.resolve(["ok": false, "reason": "permission-denied"])
                return
            }
            PushRegistrar.isEnabled = true
            await MainActor.run {
                UIApplication.shared.registerForRemoteNotifications()
                CallManager.shared.refreshRegistration()
            }
            call.resolve(["ok": true])
        }
    }

    /// Turns notifications off: unregisters from Apple and the server.
    @objc func disablePush(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        PushRegistrar.isEnabled = false
        PushRegistrar.clear()
        DispatchQueue.main.async {
            UIApplication.shared.unregisterForRemoteNotifications()
            CallManager.shared.refreshRegistration()
        }
        call.resolve()
    }

    // MARK: - Web client: calls

    /// Whether iOS rings for calls (so the page shouldn't ring too), and a call answered on the
    /// call screen before the page loaded.
    @objc func nativeCalls(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        DispatchQueue.main.async {
            var result: [String: Any] = ["ringsNatively": CallManager.shared.ringsNatively]
            if let answered = CallManager.shared.takePendingAnswer() {
                var a: [String: Any] = ["video": answered.video]
                if let cid = answered.conversationId { a["conversationId"] = cid }
                result["answered"] = a
            }
            call.resolve(result)
        }
    }

    /// The page joined or left a call: {conversationId, inCall}.
    @objc func callState(_ call: CAPPluginCall) {
        guard trusted(call) else { return }
        let cid = call.getInt("conversationId")
        let inCall = call.getBool("inCall") ?? false
        DispatchQueue.main.async {
            if inCall, let cid = cid {
                CallManager.shared.webJoined(conversationId: cid)
            } else if !inCall {
                CallManager.shared.webLeft(conversationId: cid)
            }
            call.resolve()
        }
    }

    // MARK: - Navigation

    /// Sign-in through single sign-on (OIDC) sends the page to the identity provider and back.
    /// Capacitor would open other sites in Safari, which would sign Safari in instead of the app,
    /// so redirects and page-initiated loads stay in the app. Links someone taps to other sites
    /// still open in Safari. Returns nil to let Capacitor decide.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              navigationAction.targetFrame?.isMainFrame == true else { return nil }
        let host = url.host?.lowercased()
        if host != nil && host == ServerSettings.serverHost { return false }
        if navigationAction.navigationType != .linkActivated { return false }
        // Moving around inside the sign-in site stays in the app too.
        if let current = webView?.url?.host?.lowercased(), current == host { return false }
        return nil
    }

    // MARK: -

    /// Nil when a Dendrop server answers at url, or what went wrong.
    private static func checkServer(_ url: String) async -> String? {
        guard let info = URL(string: url + "/api/auth/info") else { return "That doesn't look like a web address." }
        do {
            let (data, res) = try await URLSession.shared.data(for: URLRequest(url: info, timeoutInterval: 10))
            let code = (res as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 { return "Something answered at \(url), but it isn't a Dendrop server (HTTP \(code))." }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if json?["localLogin"] == nil && json?["oidc"] == nil { return "Something answered at \(url), but it isn't a Dendrop server." }
            return nil
        } catch let error as URLError {
            switch error.code {
            case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .secureConnectionFailed:
                return "Couldn't make a secure connection to \(url). Check its HTTPS certificate (a self-signed one has to be trusted on the iPhone first, see the app's README)."
            case .cannotFindHost, .dnsLookupFailed:
                return "Couldn't find \(url). Check the address, and that you're on the right network."
            case .appTransportSecurityRequiresSecureConnection:
                return "iOS wouldn't open \(url) without HTTPS."
            default:
                return "Couldn't reach \(url) (\(error.code.rawValue))."
            }
        } catch {
            return "Couldn't reach \(url)."
        }
    }
}
