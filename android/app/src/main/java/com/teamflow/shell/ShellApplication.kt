package com.teamflow.shell

import android.app.Application
import android.os.Build
import android.webkit.WebView

class ShellApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // 디버그 빌드에서만 켭니다. 켜 두면 `chrome://inspect` 로 웹 쪽
        // 콘솔을 볼 수 있는데, **배포 빌드에서 켜 두면 누구나 붙을 수
        // 있습니다** — 이 앱이 나르는 것은 회의 음성입니다.
        if (BuildConfig.DEBUG && Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }
}
