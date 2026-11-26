package com.fatfish.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;

/** 开机自启动：把悬浮球和语音唤醒拉起来 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (!Cfg.p(c).getBoolean("autostart", true)) return;
        if (!Settings.canDrawOverlays(c)) return;
        try {
            c.startForegroundService(new Intent(c, OrbService.class));
        } catch (Throwable e) {
            // 部分系统会拦截开机后台启动，需要在系统设置里允许“自启动”
        }
    }
}
