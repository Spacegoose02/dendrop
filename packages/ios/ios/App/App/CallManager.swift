import AVFoundation
import CallKit
import Foundation
import PushKit
import UIKit

/// The native side of calls: PushKit wakes the app for a call, and CallKit shows iOS's own
/// incoming call screen (on the lock screen too), then keeps the call going in the background
/// with the green call pill and the usual controls.
///
/// The call itself stays WebRTC in the web client. The push says only "call"; the caller's name
/// is fetched from your own server with the session cookie, never sent through Apple.
final class CallManager: NSObject {

    static let shared = CallManager()

    /// The call CallKit knows about.
    private struct Current {
        let uuid: UUID
        var conversationId: Int?
        var video: Bool
        var answered: Bool
        /// Started from the web client (an outgoing call, or one answered in the page).
        var fromWeb: Bool
    }

    private let registry = PKPushRegistry(queue: .main)
    private let provider: CXProvider
    private let controller = CXCallController()
    private var current: Current?
    private var watch: Timer?
    private var ringTimeout: Timer?
    /// The web client asked for this call to end, so it doesn't need telling.
    private var endingFromWeb = Set<UUID>()

    /// An answer that happened before the web client was ready. It picks this up when it loads.
    private(set) var pendingAnswer: (conversationId: Int?, video: Bool)?

    /// Sends events to the web client ("callAnswered", "callEnded"). Set by DendropPlugin.
    var emit: ((String, [String: Any]) -> Void)?

    private override init() {
        // The name under the call screen comes from the app's display name.
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    /// Called at launch. VoIP pushes are only asked for while notifications are on.
    func start() {
        registry.delegate = self
        refreshRegistration()
    }

    func refreshRegistration() {
        registry.desiredPushTypes = PushRegistrar.isEnabled ? [.voIP] : []
    }

    /// Whether CallKit rings for calls, so the web client can leave ringing to it.
    var ringsNatively: Bool { PushRegistrar.isEnabled && PushRegistrar.hasVoipToken }

    func takePendingAnswer() -> (conversationId: Int?, video: Bool)? {
        defer { pendingAnswer = nil }
        return pendingAnswer
    }

    // MARK: - From the web client

    /// The web client joined a call (answered in the page, or started one). CallKit is told it's
    /// an ongoing call, so iOS keeps the app and its audio running with the screen off.
    func webJoined(conversationId: Int) {
        if var c = current {
            c.conversationId = c.conversationId ?? conversationId
            current = c
            return
        }
        let uuid = UUID()
        current = Current(uuid: uuid, conversationId: conversationId, video: false, answered: true, fromWeb: true)
        let start = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: "Dendrop"))
        controller.request(CXTransaction(action: start)) { error in
            if error != nil, self.current?.uuid == uuid { self.current = nil }
        }
    }

    /// The web client left the call (hung up, or the call ended).
    func webLeft(conversationId: Int?) {
        guard let c = current, conversationId == nil || c.conversationId == nil || c.conversationId == conversationId else { return }
        endingFromWeb.insert(c.uuid)
        controller.request(CXTransaction(action: CXEndCallAction(call: c.uuid))) { error in
            if error != nil {
                // CallKit had already forgotten it.
                self.provider.reportCall(with: c.uuid, endedAt: nil, reason: .remoteEnded)
                self.finish(c.uuid)
            }
        }
    }

    // MARK: - Ringing

    private func reportIncoming(completion: @escaping () -> Void) {
        let uuid = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "Dendrop")
        update.localizedCallerName = "Dendrop call"
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        // iOS insists every VoIP push shows a call. One is already going: report this one and
        // end it straight away, which iOS accepts and which doesn't disturb the call.
        if current != nil {
            provider.reportNewIncomingCall(with: uuid, update: update) { _ in
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
                completion()
            }
            return
        }

        current = Current(uuid: uuid, conversationId: nil, video: false, answered: false, fromWeb: false)
        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            completion()
            guard error == nil else {
                // Do Not Disturb, a blocked caller or a call already in progress elsewhere.
                if self.current?.uuid == uuid { self.current = nil }
                return
            }
            self.watchRinging(uuid)
        }
    }

    /// Looks up who's calling, then keeps checking until the call is answered, so the screen
    /// stops ringing when the caller hangs up or someone answers on another device.
    private func watchRinging(_ uuid: UUID) {
        ringTimeout?.invalidate()
        ringTimeout = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in
            guard let self = self, let c = self.current, c.uuid == uuid, !c.answered else { return }
            self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
            self.finish(uuid)
        }
        Task { await self.lookUp(uuid, first: true) }
        watch?.invalidate()
        watch = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { await self?.lookUp(uuid, first: false) }
        }
    }

    @MainActor
    private func lookUp(_ uuid: UUID, first: Bool) async {
        guard current?.uuid == uuid, current?.answered == false else {
            if current == nil || current?.answered == true { stopWatching() }
            return
        }
        async let meRes = ServerAPI.request("GET", "/api/me")
        async let callsRes = ServerAPI.request("GET", "/api/calls")
        let (me, calls) = await (meRes, callsRes)
        guard current?.uuid == uuid, current?.answered == false else { return }
        guard let myId = (me.json as? [String: Any])?["id"] as? Int, let list = calls.json as? [[String: Any]] else {
            // Signed out or the server is unreachable: let it ring out rather than guess.
            return
        }
        let ringingMe = list.filter { (($0["ringing"] as? [Int]) ?? []).contains(myId) }
        let call = ringingMe.first(where: { ($0["conversationId"] as? Int) == current?.conversationId }) ?? ringingMe.first
        guard let call = call, let cid = call["conversationId"] as? Int else {
            let answeredElsewhere = list.contains { (($0["joined"] as? [Int]) ?? []).contains(myId) && ($0["conversationId"] as? Int) == current?.conversationId }
            provider.reportCall(with: uuid, endedAt: nil, reason: answeredElsewhere ? .answeredElsewhere : .remoteEnded)
            finish(uuid)
            return
        }
        let video = (call["video"] as? Bool) ?? false
        current?.conversationId = cid
        current?.video = video
        guard first else { return }

        let update = CXCallUpdate()
        update.hasVideo = video
        if let conv = (await ServerAPI.request("GET", "/api/conversations/\(cid)")).json as? [String: Any] {
            let members = (conv["members"] as? [[String: Any]]) ?? []
            let caller = members.first { ($0["id"] as? Int) == (call["startedBy"] as? Int) }?["displayName"] as? String
            let isGroup = (conv["isGroup"] as? Bool) ?? false
            let groupName = conv["name"] as? String
            if let caller = caller {
                update.localizedCallerName = isGroup ? "\(caller) in \(groupName ?? "a group")" : caller
            }
        }
        if current?.uuid == uuid { provider.reportCall(with: uuid, updated: update) }
    }

    private func stopWatching() {
        watch?.invalidate()
        watch = nil
        ringTimeout?.invalidate()
        ringTimeout = nil
    }

    private func finish(_ uuid: UUID) {
        endingFromWeb.remove(uuid)
        guard current?.uuid == uuid else { return }
        current = nil
        stopWatching()
    }

    private func configureAudioSession() {
        // What WebRTC uses too, so CallKit and the page agree on the audio route.
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
    }
}

// MARK: - PushKit

extension CallManager: PKPushRegistryDelegate {

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        PushRegistrar.saveVoipToken(pushCredentials.token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        PushRegistrar.saveVoipToken(nil)
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else {
            completion()
            return
        }
        reportIncoming(completion: completion)
    }
}

// MARK: - CallKit

extension CallManager: CXProviderDelegate {

    func providerDidReset(_ provider: CXProvider) {
        current = nil
        stopWatching()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        configureAudioSession()
        action.fulfill()
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard var c = current, c.uuid == action.callUUID else {
            action.fail()
            return
        }
        configureAudioSession()
        c.answered = true
        current = c
        stopWatching()
        action.fulfill()
        // The page joins the call; if it isn't loaded yet (the phone was locked), it asks for
        // this when it starts.
        pendingAnswer = (c.conversationId, c.video)
        var event: [String: Any] = ["video": c.video]
        if let cid = c.conversationId { event["conversationId"] = cid }
        emit?("callAnswered", event)
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        action.fulfill()
        guard let c = current, c.uuid == action.callUUID else { return }
        let fromWeb = endingFromWeb.contains(c.uuid)
        finish(c.uuid)
        pendingAnswer = nil
        guard !fromWeb, let cid = c.conversationId else { return }
        // Declined or hung up from the call screen. Tell the server straight away (the page may
        // not be running), and the page, so it leaves too.
        Task { _ = await ServerAPI.request("POST", "/api/conversations/\(cid)/call/\(c.answered ? "leave" : "decline")", json: [:]) }
        emit?("callEnded", ["conversationId": cid])
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        // Muting is done in the call panel in the app, which knows about the microphone.
        action.fail()
    }

    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        action.fail()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {}

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}
