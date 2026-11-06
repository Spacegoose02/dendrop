package io.github.spacegoose02.dendrop.push;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.annotation.Nullable;
import io.github.spacegoose02.dendrop.ServerSettings;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Keeps the Dendrop server told where to send this phone's pushes.
 *
 * The UnifiedPush distributor (for example the ntfy app) hands us an endpoint URL and Web Push
 * keys. We send them to the server with the WebView's session cookie, so the server knows which
 * signed-in account this phone belongs to. See packages/android/README.md for the server contract.
 */
public final class PushRegistrar {

    private static final String TAG = "DendropPush";
    static final String INSTANCE = "default";

    private static final String PREFS = "dendrop.push";
    private static final String KEY_ENDPOINT = "endpoint";
    private static final String KEY_P256DH = "p256dh";
    private static final String KEY_AUTH = "auth";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_SYNCED = "syncedFingerprint";
    private static final String KEY_STATUS = "status";

    /** What the setup page shows about the server side of push. */
    public static final String STATUS_NOT_SYNCED = "not-synced";
    public static final String STATUS_SYNCED = "synced";
    public static final String STATUS_SIGNED_OUT = "signed-out";
    public static final String STATUS_SERVER_UNSUPPORTED = "server-unsupported";
    public static final String STATUS_ERROR = "error";

    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private PushRegistrar() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    @Nullable
    public static String getEndpoint(Context context) {
        return prefs(context).getString(KEY_ENDPOINT, null);
    }

    public static String getStatus(Context context) {
        return prefs(context).getString(KEY_STATUS, STATUS_NOT_SYNCED);
    }

    private static void setStatus(Context context, String status) {
        prefs(context).edit().putString(KEY_STATUS, status).apply();
    }

    public static boolean isSynced(Context context) {
        String endpoint = getEndpoint(context);
        String server = ServerSettings.getServerUrl(context);
        return endpoint != null && server != null && fingerprint(server, endpoint).equals(prefs(context).getString(KEY_SYNCED, null));
    }

    static void saveEndpoint(Context context, String endpoint, @Nullable String p256dh, @Nullable String auth) {
        prefs(context).edit().putString(KEY_ENDPOINT, endpoint).putString(KEY_P256DH, p256dh).putString(KEY_AUTH, auth).remove(KEY_SYNCED).apply();
        setStatus(context, STATUS_NOT_SYNCED);
    }

    /** Forgets the endpoint here and, best effort, on the server. */
    public static void clearEndpoint(Context context) {
        final Context app = context.getApplicationContext();
        final String endpoint = getEndpoint(app);
        final String server = ServerSettings.getServerUrl(app);
        prefs(app).edit().remove(KEY_ENDPOINT).remove(KEY_P256DH).remove(KEY_AUTH).remove(KEY_SYNCED).apply();
        setStatus(app, STATUS_NOT_SYNCED);
        if (endpoint == null || server == null) return;
        IO.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("endpoint", endpoint);
                request(server, "DELETE", body);
            } catch (Exception e) {
                Log.i(TAG, "Couldn't remove the push endpoint from the server", e);
            }
        });
    }

    /** Sends the endpoint to the server if it hasn't seen it yet. Safe to call often. */
    public static void syncIfNeeded(Context context) {
        if (!isEnabled(context) || isSynced(context)) return;
        sync(context);
    }

    /** Sends the endpoint to the server in the background. */
    public static void sync(Context context) {
        final Context app = context.getApplicationContext();
        IO.execute(() -> syncNow(app));
    }

    private static void syncNow(Context context) {
        String server = ServerSettings.getServerUrl(context);
        SharedPreferences p = prefs(context);
        String endpoint = p.getString(KEY_ENDPOINT, null);
        if (server == null || endpoint == null) return;
        try {
            JSONObject keys = new JSONObject();
            if (p.getString(KEY_P256DH, null) != null) {
                keys.put("p256dh", p.getString(KEY_P256DH, null)).put("auth", p.getString(KEY_AUTH, null));
            }
            JSONObject body = new JSONObject()
                .put("endpoint", endpoint)
                .put("keys", keys)
                .put("provider", "unifiedpush")
                .put("deviceName", Build.MANUFACTURER + " " + Build.MODEL);
            int code = request(server, "POST", body);
            if (code >= 200 && code < 300) {
                p.edit().putString(KEY_SYNCED, fingerprint(server, endpoint)).apply();
                setStatus(context, STATUS_SYNCED);
            } else if (code == 401) {
                setStatus(context, STATUS_SIGNED_OUT);
            } else if (code == 404 || code == 405) {
                setStatus(context, STATUS_SERVER_UNSUPPORTED);
            } else {
                setStatus(context, STATUS_ERROR);
            }
        } catch (IOException | JSONException e) {
            Log.i(TAG, "Couldn't send the push endpoint to the server", e);
            setStatus(context, STATUS_ERROR);
        }
    }

    /** The server's optional VAPID public key, or null when it has none or doesn't do push yet. */
    @Nullable
    public static String fetchVapidKey(String server) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(server + "/api/push/config").openConnection();
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(10_000);
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                JSONObject json = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
                String key = json.optString("vapidPublicKey", "");
                return key.isEmpty() ? null : key;
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static int request(String server, String method, JSONObject body) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(server + "/api/push/subscriptions").openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(15_000);
        conn.setRequestProperty("Content-Type", "application/json");
        String cookie = CookieManager.getInstance().getCookie(server);
        if (cookie == null) return 401;
        conn.setRequestProperty("Cookie", cookie);
        conn.setDoOutput(true);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        conn.disconnect();
        return code;
    }

    private static String fingerprint(String server, String endpoint) {
        return server + "\n" + endpoint;
    }

    public static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
        return buf.toByteArray();
    }
}
