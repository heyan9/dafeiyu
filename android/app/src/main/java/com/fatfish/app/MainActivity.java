package com.fatfish.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** 设置向导：授权 → 选唤醒词 → 启动悬浮球 */
public class MainActivity extends Activity {
    LinearLayout root;

    int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + .5f);
    }

    TextView tv(String t, int sp, int color, int top) {
        TextView x = new TextView(this);
        x.setText(t);
        x.setTextSize(sp);
        x.setTextColor(color);
        x.setPadding(0, dp(top), 0, 0);
        root.addView(x);
        return x;
    }

    Button btn(String t, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(t);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        root.addView(b);
        return b;
    }

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        ScrollView sv = new ScrollView(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(40), dp(20), dp(40));
        sv.addView(root);
        setContentView(sv);
        build();
    }

    @Override
    protected void onResume() {
        super.onResume();
        build();
    }

    void check(String label, final String key) {
        final SharedPreferences p = Cfg.p(this);
        CheckBox c = new CheckBox(this);
        c.setText(label);
        c.setChecked(p.getBoolean(key, true));
        c.setOnCheckedChangeListener((v, on) -> { p.edit().putBoolean(key, on).apply(); OrbService.reload(); });
        root.addView(c);
    }

    void build() {
        root.removeAllViews();
        final SharedPreferences p = Cfg.p(this);
        final int dark = 0xFF121212, sub = 0xFF8590A6;
        tv("大肥鱼", 26, dark, 0);
        tv("悬浮球 + 喊“大肥鱼”就开始通话", 14, sub, 2);

        boolean ov = Settings.canDrawOverlays(this);
        boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean bat = ((PowerManager) getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName());

        tv("第 1 步　悬浮窗权限　" + (ov ? "✅ 已开启" : "❌ 未开启"), 15, dark, 20);
        if (!ov) btn("去开启", v -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))));

        tv("第 2 步　麦克风和通知权限　" + (mic ? "✅ 已开启" : "❌ 未开启"), 15, dark, 14);
        if (!mic) btn("去授权", v -> requestPermissions(Build.VERSION.SDK_INT >= 33
                ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                : new String[]{Manifest.permission.RECORD_AUDIO}, 1));

        tv("第 3 步　允许后台一直运行　" + (bat ? "✅ 已允许" : "❌ 未允许"), 15, dark, 14);
        if (!bat) btn("去设置", v -> startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))));

        tv("第 4 步　小米、华为、OPPO、vivo 等手机还要手动允许：“自启动”“后台弹出界面”“锁屏后台运行”（各家叫法不同，在应用设置里找）", 13, sub, 14);
        btn("打开应用设置", v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));

        tv("唤醒词（在手机本地识别，监听时不联网、不耗额度）", 15, dark, 22);
        check("大肥鱼", "w_dfy");
        check("肥鱼", "w_fy");
        check("女儿（日常聊天里容易误触发）", "w_ne");

        tv("灵敏度", 15, dark, 10);
        RadioGroup g = new RadioGroup(this);
        String[] names = {"最灵敏（说到一半就触发，偶尔误触发）", "标准", "严格（更准，但要说清楚）"};
        for (int i = 0; i < names.length; i++) {
            RadioButton r = new RadioButton(this);
            r.setText(names[i]);
            r.setId(100 + i);
            g.addView(r);
        }
        g.check(100 + p.getInt("sens", 0));
        g.setOnCheckedChangeListener((gr, id) -> { p.edit().putInt("sens", id - 100).apply(); OrbService.reload(); });
        root.addView(g);

        tv("服务器地址（国内连不上时，换成你的香港节点地址）", 15, dark, 22);
        final EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setText(Cfg.api(this));
        root.addView(e);
        btn("保存服务器地址", v -> {
            p.edit().putString("api", e.getText().toString().trim().replaceAll("/+$", "")).apply();
            Toast.makeText(this, "已保存，重新打开聊天后生效", Toast.LENGTH_SHORT).show();
        });

        CheckBox boot = new CheckBox(this);
        boot.setText("开机自启动");
        boot.setChecked(p.getBoolean("autostart", true));
        boot.setOnCheckedChangeListener((v, on) -> p.edit().putBoolean("autostart", on).apply());
        root.addView(boot);

        tv("", 8, dark, 10);
        btn("启动悬浮球和语音唤醒", v -> {
            p.edit().putBoolean("listen", true).apply();
            try { startForegroundService(new Intent(this, OrbService.class)); } catch (Throwable ex) { Toast.makeText(this, "启动失败：" + ex.getMessage(), Toast.LENGTH_LONG).show(); }
        });
        btn("停止", v -> stopService(new Intent(this, OrbService.class)));
        btn("打开聊天（第一次先在设置里登录账号）", v -> startActivity(new Intent(this, ChatActivity.class)));
    }
}
