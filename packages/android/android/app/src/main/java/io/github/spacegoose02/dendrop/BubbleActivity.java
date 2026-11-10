package io.github.spacegoose02.dendrop;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * One chat in a bubble. It loads the web client's pop-out view of that chat
 * (/?popout=c&lt;id&gt;) from the saved server, signed in with the same cookies as the app.
 * Links to other sites open in the browser.
 */
public class BubbleActivity extends Activity {

    static final String EXTRA_CONVERSATION = "conversationId";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String server = ServerSettings.getServerUrl(this);
        long cid = getIntent().getLongExtra(EXTRA_CONVERSATION, 0);
        if (server == null || cid <= 0) {
            finish();
            return;
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#20242a"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptCookie(true);
        final String origin = Uri.parse(server).getHost();
        web.setWebViewClient(
            new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri target = request.getUrl();
                    if (origin != null && origin.equalsIgnoreCase(target.getHost())) return false;
                    String scheme = target.getScheme();
                    if ("https".equals(scheme) || "http".equals(scheme)) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        } catch (Exception e) {
                            // No browser: nothing to open it with.
                        }
                    }
                    return true;
                }
            }
        );
        setContentView(web);
        web.loadUrl(server + "/?popout=c" + cid);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
