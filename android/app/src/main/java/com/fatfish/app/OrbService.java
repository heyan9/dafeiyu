package com.fatfish.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Outline;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 悬浮球 + 语音唤醒。
 * - 悬浮球：点一下打开聊天，长按弹出菜单，按住拖动。
 * - 唤醒词在手机本地识别（Vosk 离线模型），听的时候不联网、不消耗任何额度；
 *   听到“大肥鱼 / 肥鱼 / 女儿”才会打开通话界面，之后才用到网络和模型。
 */
public class OrbService extends Service {
    static OrbService inst;
    static final int ID = 1;
    static final int[] SIZES = {44, 56, 72, 96};

    Handler ui;
    WindowManager wm;
    ImageView orb;
    WindowManager.LayoutParams lp;
    View menu;
    int sizePx;
    Model model;
    volatile int gen = 0;
    boolean chatVisible = false;

    // 触摸状态
    float tdx, tdy;
    int tsx, tsy;
    boolean tmoved, tlong;

    @Override
    public IBinder onBind(Intent i) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        ui = new Handler(Looper.getMainLooper());
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                .createNotificationChannel(new NotificationChannel("ff", "大肥鱼", NotificationManager.IMPORTANCE_LOW));
        fg(false, "大肥鱼已就绪");
        if (Settings.canDrawOverlays(this)) addOrb();
        loadAvatar();
        startWake();
    }

    @Override
    public int onStartCommand(Intent i, int f, int s) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWake();
        dismissMenu();
        try { if (orb != null) wm.removeView(orb); } catch (Throwable e) { }
        orb = null;
        inst = null;
        super.onDestroy();
    }

    int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + .5f);
    }

    // ---------------- 通知 / 前台服务 ----------------
    Notification build(String t) {
        PendingIntent pi = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, "ff").setSmallIcon(R.mipmap.ic_launcher).setContentTitle("大肥鱼")
                .setContentText(t).setContentIntent(pi).setOngoing(true).build();
    }

    void note(String t) {
        try { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(ID, build(t)); } catch (Throwable e) { }
    }

    void fg(boolean mic, String text) {
        Notification n = build(text);
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int type = 0;
                if (Build.VERSION.SDK_INT >= 34) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                if (mic) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if (type == 0) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                startForeground(ID, n, type);
            } else {
                startForeground(ID, n);
            }
        } catch (Throwable e) {
            try {
                if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                else startForeground(ID, n);
            } catch (Throwable e2) { }
        }
    }

    // ---------------- 悬浮球 ----------------
    void addOrb() {
        if (orb != null) return;
        sizePx = dp(Cfg.p(this).getInt("size", 56));
        orb = new ImageView(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(0xFF056DE8);
        orb.setBackground(g);                        // 头像没加载出来前先显示一个蓝色圆
        orb.setScaleType(ImageView.ScaleType.CENTER_CROP);
        orb.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View v, Outline o) {
                o.setOval(0, 0, v.getWidth(), v.getHeight());
            }
        });
        orb.setClipToOutline(true);
        lp = new WindowManager.LayoutParams(sizePx, sizePx, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = Cfg.p(this).getInt("ox", dp(8));
        lp.y = Cfg.p(this).getInt("oy", dp(220));

        final Runnable longPress = () -> {
            if (!tmoved) {
                tlong = true;
                orb.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                showMenu();
            }
        };
        orb.setOnTouchListener((v, e) -> {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    tdx = e.getRawX(); tdy = e.getRawY(); tsx = lp.x; tsy = lp.y; tmoved = false; tlong = false;
                    dismissMenu();
                    ui.postDelayed(longPress, 500);
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float mx = e.getRawX() - tdx, my = e.getRawY() - tdy;
                    if (!tmoved && Math.hypot(mx, my) > dp(6)) { tmoved = true; ui.removeCallbacks(longPress); }
                    if (tmoved) {
                        lp.x = (int) (tsx + mx);
                        lp.y = (int) (tsy + my);
                        try { wm.updateViewLayout(orb, lp); } catch (Throwable ex) { }
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                    ui.removeCallbacks(longPress);
                    if (tmoved) {
                        Cfg.p(this).edit().putInt("ox", lp.x).putInt("oy", lp.y).apply();
                    } else if (!tlong) {
                        openChat(false, null);       // 点一下：打开聊天
                    }
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    ui.removeCallbacks(longPress);
                    return true;
            }
            return false;
        });
        try { wm.addView(orb, lp); } catch (Throwable e) { orb = null; }
    }

    void showMenu() {
        dismissMenu();
        LinearLayout m = new LinearLayout(this);
        m.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFFFFFFFF);
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(1), 0xFFE6EDF7);
        m.setBackground(bg);
        m.setPadding(0, dp(6), 0, dp(6));
        boolean on = Cfg.p(this).getBoolean("listen", true);
        String[] names = {"📞  语音通话", "📖  她的日记", "🧠  她的记忆", "⚙️  设置",
                on ? "🔇  暂停语音唤醒" : "🎙  开启语音唤醒", "⭕  悬浮球大小", "✕  退出大肥鱼"};
        for (int i = 0; i < names.length; i++) {
            final int k = i;
            TextView t = new TextView(this);
            t.setText(names[i]);
            t.setTextSize(15);
            t.setTextColor(0xFF121212);
            t.setPadding(dp(18), dp(12), dp(24), dp(12));
            t.setOnClickListener(v -> { dismissMenu(); menuAct(k); });
            m.addView(t);
        }
        int w = dp(210);
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(w, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.START;
        DisplayMetrics dm = getResources().getDisplayMetrics();
        p.x = (lp.x + sizePx / 2 > dm.widthPixels / 2) ? Math.max(0, lp.x - w - dp(8)) : lp.x + sizePx + dp(8);
        p.y = Math.max(0, Math.min(lp.y, dm.heightPixels - dp(380)));
        m.setOnTouchListener((v, e) -> {
            if (e.getAction() == MotionEvent.ACTION_OUTSIDE) dismissMenu();
            return false;
        });
        menu = m;
        try { wm.addView(m, p); } catch (Throwable e) { menu = null; }
    }

    void dismissMenu() {
        if (menu != null) {
            try { wm.removeView(menu); } catch (Throwable e) { }
            menu = null;
        }
    }

    void menuAct(int k) {
        switch (k) {
            case 0: openChat(true, null); break;
            case 1: openChat(false, "#bd"); break;
            case 2: openChat(false, "#bm"); break;
            case 3: openChat(false, "#bs"); break;
            case 4: {
                SharedPreferences p = Cfg.p(this);
                boolean on = !p.getBoolean("listen", true);
                p.edit().putBoolean("listen", on).apply();
                if (on) startWake(); else { stopWake(); note("语音唤醒已暂停"); }
                break;
            }
            case 5: {
                int cur = Cfg.p(this).getInt("size", 56), nx = SIZES[0];
                for (int i = 0; i < SIZES.length; i++) if (SIZES[i] == cur) nx = SIZES[(i + 1) % SIZES.length];
                Cfg.p(this).edit().putInt("size", nx).apply();
                sizePx = dp(nx);
                if (orb != null) { lp.width = sizePx; lp.height = sizePx; try { wm.updateViewLayout(orb, lp); } catch (Throwable e) { } }
                break;
            }
            case 6: stopSelf(); break;
        }
    }

    void openChat(boolean call, String sel) {
        Intent i = new Intent(this, ChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("call", call).putExtra("sel", sel);
        try { startActivity(i); } catch (Throwable e) { note("系统拦截了弹出界面：请在设置里允许“后台弹出界面”"); }
    }

    void chatShown(boolean v) {
        chatVisible = v;
        ui.post(() -> { if (orb != null) orb.setVisibility(v ? View.INVISIBLE : View.VISIBLE); });
        if (v) { stopWake(); note("聊天中，语音唤醒暂停"); }
        else ui.postDelayed(this::startWake, 700);
    }

    // ---------------- 头像 ----------------
    void setAvatar(String dataUrl) {
        try {
            byte[] b = Base64.decode(dataUrl.substring(dataUrl.indexOf(',') + 1), Base64.DEFAULT);
            final Bitmap bm = BitmapFactory.decodeByteArray(b, 0, b.length);
            if (bm != null) ui.post(() -> { if (orb != null) orb.setImageBitmap(bm); });
        } catch (Exception e) { }
    }

    void loadAvatar() {
        new Thread(() -> {
            SharedPreferences p = Cfg.p(this);
            String cached = p.getString("avatar", "");
            if (!cached.isEmpty()) setAvatar(cached);
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(Cfg.api(this) + "/config").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] b = new byte[8192];
                int n;
                try (InputStream in = c.getInputStream()) { while ((n = in.read(b)) > 0) o.write(b, 0, n); }
                String a = new JSONObject(o.toString("UTF-8")).optString("avatar");
                if (a.startsWith("data:image/") && !a.equals(cached)) {
                    p.edit().putString("avatar", a).apply();
                    setAvatar(a);
                }
            } catch (Exception e) { }
        }).start();
    }

    // ---------------- 语音唤醒（本地识别） ----------------
    static void reload() {
        if (inst != null) { inst.stopWake(); inst.ui.postDelayed(inst::startWake, 400); }
    }

    synchronized void startWake() {
        if (inst == null || chatVisible) return;
        if (!Cfg.p(this).getBoolean("listen", true)) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            note("需要麦克风权限：请打开大肥鱼 App 完成授权");
            return;
        }
        final int g = ++gen;
        fg(true, "正在听你喊“大肥鱼”");
        new Thread(() -> wakeLoop(g), "wake").start();
    }

    synchronized void stopWake() {
        gen++;
    }

    void wakeLoop(int g) {
        AudioRecord ar = null;
        Recognizer rec = null;
        try {
            Model m = getModel();
            rec = new Recognizer(m, 16000f, grammar());
            rec.setWords(true);
            int min = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            ar = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 16000));
            if (ar.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("麦克风被占用或没有权限");
            ar.startRecording();
            note("正在听你喊“大肥鱼”");
            short[] buf = new short[1600];
            long last = 0;
            while (g == gen) {
                int n = ar.read(buf, 0, buf.length);
                if (n <= 0) { Thread.sleep(20); continue; }
                boolean fin = rec.acceptWaveForm(buf, n);
                String js = fin ? rec.getResult() : rec.getPartialResult();
                if (hit(js, fin) && System.currentTimeMillis() - last > 2500) {
                    last = System.currentTimeMillis();
                    if (g == gen) { gen++; ui.post(this::onWake); }
                    break;
                }
            }
        } catch (Throwable e) {
            note("语音唤醒出错：" + e.getMessage());
        } finally {
            try { if (ar != null) { ar.stop(); ar.release(); } } catch (Throwable e) { }
            try { if (rec != null) rec.close(); } catch (Throwable e) { }
        }
    }

    void onWake() {
        try {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            v.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (Throwable e) { }
        if (orb != null) orb.animate().scaleX(1.3f).scaleY(1.3f).setDuration(150)
                .withEndAction(() -> { if (orb != null) orb.animate().scaleX(1f).scaleY(1f).setDuration(150); });
        note("已唤醒，正在打开通话…");
        openChat(true, null);
    }

    String grammar() {
        SharedPreferences p = Cfg.p(this);
        JSONArray a = new JSONArray();
        // 用单字拆开写，避免“大肥鱼”不在词表里；同音/近音写法也一并放进去，提高灵敏度
        if (p.getBoolean("w_dfy", true)) { a.put("大 肥 鱼"); a.put("大 飞 鱼"); }
        if (p.getBoolean("w_fy", true)) a.put("肥 鱼");
        if (p.getBoolean("w_ne", true)) a.put("女儿");
        a.put("[unk]");
        return a.toString();
    }

    boolean has(String text) {
        SharedPreferences p = Cfg.p(this);
        String t = text.replace(" ", "");
        return (p.getBoolean("w_dfy", true) && (t.contains("大肥鱼") || t.contains("大飞鱼")))
                || (p.getBoolean("w_fy", true) && t.contains("肥鱼"))
                || (p.getBoolean("w_ne", true) && t.contains("女儿"));
    }

    /** sens: 0=最灵敏（说到一半就触发） 1=标准 2=严格 */
    boolean hit(String js, boolean fin) {
        try {
            int sens = Cfg.p(this).getInt("sens", 0);
            JSONObject o = new JSONObject(js);
            if (!fin) return sens == 0 && has(o.optString("partial"));
            if (!has(o.optString("text"))) return false;
            if (sens == 0) return true;
            JSONArray a = o.optJSONArray("result");
            if (a == null || a.length() == 0) return sens == 1;
            double min = sens == 1 ? 0.6 : 0.85, low = 1;
            for (int i = 0; i < a.length(); i++) {          // “大/肥/鱼”是分开的词，取其中最低的置信度
                JSONObject w = a.getJSONObject(i);
                if (!"[unk]".equals(w.optString("word"))) low = Math.min(low, w.optDouble("conf", 1));
            }
            return low >= min;
        } catch (Exception e) {
            return false;
        }
    }

    synchronized Model getModel() throws IOException {
        if (model == null) {
            File d = new File(getFilesDir(), "model-cn"), ok = new File(d, ".ok");
            if (!ok.exists()) {
                note("首次使用，正在准备唤醒模型（几秒钟）…");
                rm(d);
                copyAssets("model-cn", d);
                ok.createNewFile();
            }
            model = new Model(d.getAbsolutePath());
        }
        return model;
    }

    void rm(File f) {
        File[] l = f.listFiles();
        if (l != null) for (File c : l) rm(c);
        f.delete();
    }

    void copyAssets(String a, File d) throws IOException {
        String[] l = getAssets().list(a);
        if (l != null && l.length > 0) {
            d.mkdirs();
            for (String s : l) copyAssets(a + "/" + s, new File(d, s));
            return;
        }
        try (InputStream in = getAssets().open(a)) {
            d.getParentFile().mkdirs();
            try (OutputStream out = new FileOutputStream(d)) {
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
            }
        } catch (FileNotFoundException e) {
            d.mkdirs();
        }
    }
}
