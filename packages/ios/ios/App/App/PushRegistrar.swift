import Foundation
import UIKit
import UserNotifications

/// Keeps the Dendrop server told where to send this iPhone's pushes.
///
/// iOS gives the app two tokens: an alert token (for "You have a new message") and a VoIP token
/// (PushKit, which rings the native incoming call screen). They're sent to the server as
/// apns://<environment>/<token> and apns-voip://<environment>/<token>, with the WebView's session
/// cookie, so the server knows which signed-in account this phone belongs to.
/// A push never carries what was said: the server sends fixed words, see packages/ios/README.md.
enum PushRegistrar {

    static let statusNotSynced = "not-synced"
    static let statusSynced = "synced"
    static let statusSignedOut = "signed-out"
    static let statusServerUnsupported = "server-unsupported"
    /// The server takes the tokens but has no APNs key, so it can't reach iPhones yet.
    static let statusServerNoApns = "server-no-apns"
    static let statusError = "error"

    private static let defaults = UserDefaults.standard
    private static let kEnabled = "push.enabled"
    private static let kAlert = "push.alertToken"
    private static let kVoip = "push.voipToken"
    private static let kSynced = "push.synced"
    private static let kStatus = "push.status"
    private static let kSent = "push.sentEndpoints"

    static var isEnabled: Bool {
        get { defaults.bool(forKey: kEnabled) }
        set { defaults.set(newValue, forKey: kEnabled) }
    }

    static var status: String { defaults.string(forKey: kStatus) ?? statusNotSynced }
    static var hasTokens: Bool { defaults.string(forKey: kAlert) != nil }
    static var hasVoipToken: Bool { defaults.string(forKey: kVoip) != nil }

    static func saveAlertToken(_ token: Data?) { save(token, kAlert) }
    static func saveVoipToken(_ token: Data?) { save(token, kVoip) }

    private static func save(_ token: Data?, _ key: String) {
        let hex = token.map { $0.map { String(format: "%02x", $0) }.joined() }
        guard defaults.string(forKey: key) != hex else { return }
        defaults.set(hex, forKey: key)
        defaults.removeObject(forKey: kSynced)
        defaults.set(statusNotSynced, forKey: kStatus)
        sync()
    }

    /// Xcode builds get pushes from Apple's sandbox, TestFlight and App Store builds from production.
    /// The provisioning profile says which; App Store builds have none, which means production.
    static let environment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url),
              let text = String(data: raw, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>"),
              let plist = try? PropertyListSerialization.propertyList(from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any] else { return "production" }
        return (entitlements["aps-environment"] as? String) == "development" ? "sandbox" : "production"
    }()

    private static func endpoints() -> [String] {
        var list: [String] = []
        if let t = defaults.string(forKey: kAlert) { list.append("apns://\(environment)/\(t)") }
        if let t = defaults.string(forKey: kVoip) { list.append("apns-voip://\(environment)/\(t)") }
        return list
    }

    private static func fingerprint() -> String? {
        guard let server = ServerSettings.serverURL, hasTokens else { return nil }
        return ([server] + endpoints()).joined(separator: "\n")
    }

    static var isSynced: Bool {
        guard let f = fingerprint() else { return false }
        return defaults.string(forKey: kSynced) == f
    }

    /// Sends the tokens to the server if it hasn't seen them yet. Safe to call often.
    static func syncIfNeeded() {
        guard isEnabled, !isSynced else { return }
        sync()
    }

    static func sync() {
        Task { await syncNow() }
    }

    @discardableResult
    static func syncNow() async -> String {
        guard isEnabled, let f = fingerprint() else { return status }
        let device = await MainActor.run { UIDevice.current.name }
        var result = statusSynced
        for endpoint in endpoints() {
            let res = await ServerAPI.request("POST", "/api/push/subscriptions", json: [
                "endpoint": endpoint,
                "provider": endpoint.hasPrefix("apns-voip") ? "apns-voip" : "apns",
                "deviceName": device,
            ])
            if res.ok { continue }
            result = res.status == 401 ? statusSignedOut : res.status == 404 || res.status == 405 || res.status == 400 ? statusServerUnsupported : statusError
            break
        }
        if result == statusSynced {
            defaults.set(f, forKey: kSynced)
            defaults.set(endpoints(), forKey: kSent)
            let config = await ServerAPI.request("GET", "/api/push/config", signedIn: false)
            let apns = (config.json as? [String: Any])?["apns"] as? [String: Any]
            if (apns?["enabled"] as? Bool) != true { result = statusServerNoApns }
        }
        defaults.set(result, forKey: kStatus)
        return result
    }

    /// Forgets the tokens here and, best effort, on the server.
    static func clear() {
        let sent = (defaults.stringArray(forKey: kSent) ?? []) + endpoints()
        for k in [kAlert, kVoip, kSynced, kSent] { defaults.removeObject(forKey: k) }
        defaults.set(statusNotSynced, forKey: kStatus)
        Task {
            for endpoint in Set(sent) {
                _ = await ServerAPI.request("DELETE", "/api/push/subscriptions", json: ["endpoint": endpoint])
            }
        }
    }

    /// Whether iOS lets Dendrop show notifications at all.
    static func notificationsAllowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }
}
