import UIKit
import Capacitor
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    /// Looks again for the first sign-in, which happens inside the page without telling the app.
    private static var syncTimer: Timer?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Capacitor's own notification handling is off (capacitor.config.json), so this is ours.
        UNUserNotificationCenter.current().delegate = self
        // PushKit has to be set up at every launch, including the one a call push causes.
        CallManager.shared.start()
        if PushRegistrar.isEnabled { application.registerForRemoteNotifications() }
        return true
    }

    // MARK: - Push

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.saveAlertToken(deviceToken)
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    /// The open app already shows new messages, so a message notification is only shown when
    /// it's in the background (iOS asks here only while it's in front).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let kind = notification.request.content.userInfo["type"] as? String
        completionHandler(kind == "event" ? [.banner, .sound] : [])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        // Tapping it opens the app, which shows the rest.
        completionHandler()
    }

    /// The app came to the front: clear the "new message" notifications and catch up on push sign-up.
    static func becameActive() {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { ($0.request.content.userInfo["type"] as? String) != "event" }.map { $0.request.identifier }
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
        center.setBadgeCount(0)
        PushRegistrar.syncIfNeeded()
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { timer in
            guard PushRegistrar.isEnabled, !PushRegistrar.isSynced, UIApplication.shared.applicationState == .active else {
                timer.invalidate()
                return
            }
            PushRegistrar.sync()
        }
    }

    // MARK: - Capacitor

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
