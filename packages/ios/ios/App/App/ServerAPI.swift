import Foundation
import WebKit

/// Requests to the Dendrop server made by the app itself (outside the web page), signed in with
/// the same session cookie the WebView has. Used for push sign-up and for the call screen.
enum ServerAPI {

    struct Response {
        let status: Int
        let data: Data?

        var ok: Bool { (200..<300).contains(status) }
        var json: Any? { data.flatMap { try? JSONSerialization.jsonObject(with: $0) } }
    }

    /// The WebView's cookies for this server, as a Cookie header, or nil when signed out.
    @MainActor
    static func cookieHeader(for server: URL) async -> String? {
        let cookies: [HTTPCookie] = await withCheckedContinuation { done in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { done.resume(returning: $0) }
        }
        guard let host = server.host?.lowercased() else { return nil }
        let matching = cookies.filter { cookie in
            let domain = cookie.domain.lowercased()
            if domain.hasPrefix(".") { return host == domain.dropFirst() || host.hasSuffix(domain) }
            return host == domain
        }
        guard !matching.isEmpty else { return nil }
        return HTTPCookie.requestHeaderFields(with: matching)["Cookie"]
    }

    /// Sends a request to the saved server. Status 401 means signed out (or no cookie yet),
    /// and 0 that the server couldn't be reached.
    static func request(_ method: String, _ path: String, json: Any? = nil, signedIn: Bool = true) async -> Response {
        guard let server = ServerSettings.serverURL, let base = URL(string: server), let url = URL(string: server + path) else {
            return Response(status: 0, data: nil)
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = method
        if signedIn {
            guard let cookie = await cookieHeader(for: base) else { return Response(status: 401, data: nil) }
            req.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        if let json = json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        // The cookie is set by hand above; don't let URLSession add or store its own.
        req.httpShouldHandleCookies = false
        do {
            let (data, res) = try await URLSession.shared.data(for: req)
            return Response(status: (res as? HTTPURLResponse)?.statusCode ?? 0, data: data)
        } catch {
            return Response(status: 0, data: nil)
        }
    }
}
