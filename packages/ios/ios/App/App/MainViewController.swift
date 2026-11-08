import Capacitor
import UIKit

/// Opens the Dendrop web client from the user's own server, so the app always matches the
/// server's version and signs in with the same cookies as a browser would. Before a server is
/// chosen, and whenever it can't be reached, it shows the bundled setup page (www/index.html).
class MainViewController: CAPBridgeViewController {

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let server = ServerSettings.serverURL { descriptor.serverURL = server }
        // The den theme's background (--dd-bg-main), so there's no white flash while loading.
        descriptor.backgroundColor = UIColor(red: 0x20 / 255, green: 0x24 / 255, blue: 0x2a / 255, alpha: 1)
        return descriptor
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DendropPlugin())
        // Swipe from the edge to go back, like Safari.
        webView?.allowsBackForwardNavigationGestures = true
    }

    /// Shows the bundled setup page, where the server and notifications can be changed.
    func showSettings() {
        guard let local = bridge?.config.localURL,
              let url = URL(string: local.appendingPathComponent("dendrop-offline.html").absoluteString + "#settings") else { return }
        webView?.load(URLRequest(url: url))
    }
}
