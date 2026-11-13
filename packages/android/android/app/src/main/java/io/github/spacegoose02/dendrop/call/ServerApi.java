package io.github.spacegoose02.dendrop.call;

import android.content.Context;
import android.webkit.CookieManager;
import androidx.annotation.Nullable;
import io.github.spacegoose02.dendrop.ServerSettings;
import io.github.spacegoose02.dendrop.push.PushRegistrar;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Requests to the Dendrop server made by the app itself (outside the web page), signed in with
 * the WebView's session cookie. Used by the call notification to see who is calling and to
 * decline or hang up without opening the app. Call off the main thread.
 */
final class ServerApi {

    /** status 0: the server couldn't be reached; 401: signed out (or no cookie yet). */
    static final class Response {

        final int status;
        @Nullable
        final String body;

        Response(int status, @Nullable String body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }

        @Nullable
        JSONObject object() {
            try {
                return body == null ? null : new JSONObject(body);
            } catch (Exception e) {
                return null;
            }
        }

        @Nullable
        JSONArray array() {
            try {
                return body == null ? null : new JSONArray(body);
            } catch (Exception e) {
                return null;
            }
        }
    }

    private ServerApi() {}

    static Response request(Context context, String method, String path, @Nullable JSONObject json) {
        String server = ServerSettings.getServerUrl(context);
        if (server == null) return new Response(0, null);
        String cookie;
        try {
            cookie = CookieManager.getInstance().getCookie(server);
        } catch (Exception e) {
            // No WebView on this device.
            return new Response(0, null);
        }
        if (cookie == null || cookie.isEmpty()) return new Response(401, null);
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(server + path).openConnection();
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(10_000);
            conn.setRequestMethod(method);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Accept", "application/json");
            if (json != null) {
                byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body);
                }
            }
            int code = conn.getResponseCode();
            String text = null;
            try (InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                if (in != null) text = new String(PushRegistrar.readAll(in), StandardCharsets.UTF_8);
            }
            return new Response(code, text);
        } catch (Exception e) {
            return new Response(0, null);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
