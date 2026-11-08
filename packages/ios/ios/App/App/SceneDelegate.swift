import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// The home screen quick action (long-press the icon) that opens the setup page.
    static let settingsShortcut = "io.github.spacegoose02.dendrop.settings"

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        if window?.rootViewController == nil {
            window = UIWindow(windowScene: windowScene)
            window?.rootViewController = MainViewController()
            window?.makeKeyAndVisible()
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        if connectionOptions.shortcutItem?.type == Self.settingsShortcut {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.main?.showSettings() }
        }
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        let handled = shortcutItem.type == Self.settingsShortcut
        if handled { main?.showSettings() }
        completionHandler(handled)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        AppDelegate.becameActive()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    private var main: MainViewController? { window?.rootViewController as? MainViewController }
}
