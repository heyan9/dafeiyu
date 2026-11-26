package com.fatfish.app;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

final class Cfg {
    static SharedPreferences p(Context c) {
        return c.getApplicationContext().getSharedPreferences("ff", Context.MODE_PRIVATE);
    }

    /** 服务器地址：优先用 App 里手动填的，没有就用打包时的 config.json */
    static String api(Context c) {
        String a = p(c).getString("api", "");
        if (a.isEmpty()) {
            try (InputStream in = c.getAssets().open("config.json")) {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] b = new byte[4096];
                int n;
                while ((n = in.read(b)) > 0) o.write(b, 0, n);
                a = new JSONObject(o.toString("UTF-8")).optString("api");
            } catch (Exception e) {
                a = "";
            }
        }
        return a.replaceAll("/+$", "");
    }
}
