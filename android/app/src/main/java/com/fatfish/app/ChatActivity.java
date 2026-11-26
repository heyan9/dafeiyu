package com.fatfish.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** 聊天界面：直接加载打包在 App 里的网页（不依赖 GitHub Pages），和网页版是同一套界面 */
public class ChatActivity extends Activity {
    WebView w;
    ValueCallback<Uri[]> chooser;
    String pending;
    boolean loaded;

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        w = new WebView(this);
        w.setBackgroundColor(Color.WHITE);
        setContentView(w);

        WebSettings t = w.getSettings();
        t.setJavaScriptEnabled(true);
        t.setDomStorageEnabled(true);
        t.setMediaPlaybackRequiresUserGesture(false);   // 通话时自动播放她的语音
        t.setAllowFileAccess(true);
        t.setAllowFileAccessFromFileURLs(true);
        t.setAllowUniversalAccessFromFileURLs(true);
        t.setTextZoom(100);
        w.addJavascriptInterface(new Bridge(), "AndroidBridge");

        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (r.getUrl().toString().startsWith("file:")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); } catch (Exception e) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String u) {
                loaded = true;
                runPending();
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(() -> {
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        req.grant(req.getResources());
                    } else {
                        req.deny();
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 2);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = cb;
                try {
                    startActivityForResult(p.createIntent(), 9);
                } catch (Exception e) {
                    chooser = null;
                    return false;
                }
                return true;
            }
        });

        w.loadUrl("file:///android_asset/site/index.html?api=" + Uri.encode(Cfg.api(this)));
        handle(getIntent());
    }

    /** 从悬浮球进来：call=true 直接开始通话；sel 是要点击的按钮（日记/记忆/设置） */
    void handle(Intent i) {
        StringBuilder js = new StringBuilder();
        if (i.getBooleanExtra("call", false)) js.append("typeof startCall==='function'&&startCall();");
        String sel = i.getStringExtra("sel");
        if (sel != null) js.append("(document.querySelector('").append(sel).append("')||{click(){}}).click();");
        if (js.length() > 0) {
            pending = js.toString();
            if (loaded) runPending();
        }
    }

    void runPending() {
        if (pending == null) return;
        final String j = pending;
        pending = null;
        w.postDelayed(() -> w.evaluateJavascript("try{" + j + "}catch(e){}", null), 700);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handle(i);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (OrbService.inst != null) OrbService.inst.chatShown(true);   // 聊天界面打开时，暂停监听并隐藏悬浮球
    }

    @Override
    protected void onStop() {
        super.onStop();
        w.evaluateJavascript("try{typeof endCall==='function'&&endCall()}catch(e){}", null);
        if (OrbService.inst != null) OrbService.inst.chatShown(false); // 离开后恢复监听
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true);
    }

    @Override
    protected void onActivityResult(int rq, int rs, Intent d) {
        if (rq == 9 && chooser != null) {
            chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(rs, d));
            chooser = null;
        }
    }

    class Bridge {
        @JavascriptInterface
        public void callEnded() {
            runOnUiThread(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public void avatar(String a) {
            if (a != null && a.startsWith("data:image/") && a.length() < 400000) {
                Cfg.p(ChatActivity.this).edit().putString("avatar", a).apply();
                if (OrbService.inst != null) OrbService.inst.setAvatar(a);
            }
        }
    }
}
