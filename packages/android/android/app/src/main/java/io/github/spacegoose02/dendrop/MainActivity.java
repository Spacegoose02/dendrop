package io.github.spacegoose02.dendrop;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.WebViewListener;
import io.github.spacegoose02.dendrop.call.IncomingCalls;
import io.github.spacegoose02.dendrop.push.Notifier;
import io.github.spacegoose02.dendrop.push.PushRegistrar;

/**
 * Opens the Dendrop web client from the user's own server, so the app always matches the server's
 * version and signs in with the same cookies as the browser does. Before a server is chosen, and
 * whenever it can't be reached, it shows the bundled setup page (www/index.html) instead.
 */
public class MainActivity extends BridgeActivity {

    /** Sent by the "Server settings" launcher shortcut. */
    static final String ACTION_SETTINGS = "io.github.spacegoose02.dendrop.SETTINGS";
    /** Sent after Answer on the incoming call notification; the page joins the call. */
    public static final String ACTION_ANSWER = "io.github.spacegoose02.dendrop.ANSWER";
    /** The bundled page, served at the server's origin when the server is unreachable. */
    static final String OFFLINE_PAGE = "dendrop-offline.html";

    private static volatile boolean inForeground = false;
    private static final long PUSH_SYNC_INTERVAL_MS = 30_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable pushSync = new Runnable() {
        @Override
        public void run() {
            // Catches the first sign-in, which happens inside the page without a reload.
            PushRegistrar.syncIfNeeded(MainActivity.this);
            if (PushRegistrar.isEnabled(MainActivity.this) && !PushRegistrar.isSynced(MainActivity.this)) {
                handler.postDelayed(this, PUSH_SYNC_INTERVAL_MS);
            }
        }
    };

    public static boolean isInForeground() {
        return inForeground;
    }

    /** Starts the app over, for example after choosing another server. */
    static void restart(Activity activity) {
        Intent intent = new Intent(activity, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity.startActivity(intent);
        activity.finish();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DendropPlugin.class);
        config = buildConfig();
        super.onCreate(savedInstanceState);
        if (bridge == null) return; // No WebView on this device; Capacitor shows its own message.

        Notifier.createChannels(this);
        bridge.setWebViewClient(new DendropWebViewClient(bridge));
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    PushRegistrar.syncIfNeeded(MainActivity.this);
                }
            }
        );
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge.getWebView();
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    // Keep the app (and its connection) alive instead of closing it, like other chat apps.
                    moveTaskToBack(true);
                }
            }
        });
        if (ACTION_SETTINGS.equals(getIntent().getAction())) showSettings();
        if (isCallIntent(getIntent())) showOverLockScreen(true);
    }

    private static boolean isCallIntent(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        return Notifier.ACTION_CALL.equals(action) || ACTION_ANSWER.equals(action);
    }

    /**
     * For an incoming call: show over the lock screen and wake the screen, so the call can be
     * answered without unlocking first. Turned off again when the app goes to the background.
     */
    private void showOverLockScreen(boolean on) {
        if (Build.VERSION.SDK_INT < 27) return;
        setShowWhenLocked(on);
        setTurnScreenOn(on);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (bridge != null && ACTION_SETTINGS.equals(intent.getAction())) showSettings();
        if (isCallIntent(intent)) showOverLockScreen(true);
    }

    @Override
    public void onResume() {
        super.onResume();
        inForeground = true;
        Notifier.clear(this);
        // The app's own ringer takes over from the notification once it's open.
        IncomingCalls.stop(this);
        handler.removeCallbacks(pushSync);
        handler.post(pushSync);
        if (bridge != null) UpdateChecker.maybeCheck(this);
    }

    @Override
    public void onPause() {
        super.onPause();
        inForeground = false;
        handler.removeCallbacks(pushSync);
        showOverLockScreen(false);
    }

    private CapConfig buildConfig() {
        CapConfig.Builder builder = new CapConfig.Builder(this).setErrorPath(OFFLINE_PAGE).setBackgroundColor("#20242a");
        String server = ServerSettings.getServerUrl(this);
        if (server != null) builder.setServerUrl(server);
        return builder.create();
    }

    /** Shows the bundled setup page, where the server and notifications can be changed. */
    private void showSettings() {
        bridge.getWebView().loadUrl(bridge.getErrorUrl() + "#settings");
    }

    /**
     * Sign-in through single sign-on (OIDC) sends the WebView to the identity provider and back.
     * Capacitor would open other sites in the browser, which would sign the browser in instead of
     * the app, so redirects stay in the app. Links someone taps still open in the browser.
     */
    private static class DendropWebViewClient extends BridgeWebViewClient {

        DendropWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri target = request.getUrl();
            String scheme = target.getScheme();
            boolean web = "https".equals(scheme) || "http".equals(scheme);
            if (web && request.isForMainFrame()) {
                if (request.isRedirect()) return false;
                // Moving around inside the sign-in site (or inside Dendrop) stays in the app too.
                String current = view.getUrl();
                String host = current == null ? null : Uri.parse(current).getHost();
                if (host != null && host.equalsIgnoreCase(target.getHost())) return false;
            }
            return super.shouldOverrideUrlLoading(view, request);
        }
    }
}
