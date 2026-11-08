import Foundation

/// The Dendrop server this app talks to, kept in the app's own preferences.
enum ServerSettings {

    private static let key = "serverUrl"

    /// The saved server origin, such as https://chat.example.com, or nil before setup.
    static var serverURL: String? {
        get { UserDefaults.standard.string(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// The saved server's host, for deciding what stays inside the app.
    static var serverHost: String? {
        serverURL.flatMap { URL(string: $0)?.host?.lowercased() }
    }

    /// Turns what someone typed into a server origin: adds https:// when no scheme was given and
    /// drops any path, since the web client is always served from the root.
    /// Returns nil when it isn't a usable http(s) address.
    static func normalize(_ input: String?) -> String? {
        guard var s = input?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard let c = URLComponents(string: s),
              let scheme = c.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = c.host?.lowercased(), !host.isEmpty else { return nil }
        let port = c.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }
}
