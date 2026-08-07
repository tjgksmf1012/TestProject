package com.teamflow.shell

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

/**
 * TeamFlow 화면을 감싸는 껍데기.
 *
 * 여기에는 화면이 없습니다. `frontend/public` 을 그대로 띄우고, 웹이 혼자
 * 할 수 없는 것 두 가지만 대신합니다.
 *
 *   1. **마이크 권한** — WebView 의 `getUserMedia` 는 앱이 이미 받아 둔
 *      권한 위에서만 동작합니다. 앱 권한이 없으면 웹에서 아무리 요청해도
 *      거절만 돌아옵니다.
 *   2. **녹음이 끊기지 않게 하는 것** — `RecordingService` 가 합니다.
 *      이것이 이 셸의 존재 이유입니다 (README 참고).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    /**
     * 마이크 권한 요청 결과를 기다리는 웹 쪽 요청.
     *
     * WebView 는 `onPermissionRequest` 를 **동기적으로** 물어보는데,
     * 안드로이드 권한 대화상자는 비동기입니다. 그래서 붙잡아 뒀다가
     * 결과가 오면 답합니다. 붙잡아 두지 않으면 첫 요청이 항상 거절되고,
     * 사람은 "권한을 줬는데 왜 안 되지" 가 됩니다.
     */
    private var pendingWebRequest: PermissionRequest? = null

    private val askMicrophone =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val request = pendingWebRequest
            pendingWebRequest = null
            if (request == null) return@registerForActivityResult

            if (granted) {
                request.grant(request.resources)
            } else {
                // 조용히 넘어가지 않습니다. 웹에 거절을 알려야 로비 화면이
                // "마이크 권한이 없어 녹음할 수 없습니다" 를 그립니다.
                request.deny()
            }
        }

    /** 알림 권한(안드로이드 13+). 없으면 포그라운드 알림이 안 보입니다. */
    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                Log.w(TAG, "알림 권한이 없습니다 — 녹음 중 표시가 보이지 않습니다")
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 노치·홈 인디케이터 뒤까지 그립니다. 웹 쪽 `app.css` 가
        // `env(safe-area-inset-*)` 로 여백을 잡습니다.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // ⚠️ 웹 쪽 서비스 워커를 쓰지 않습니다. 셸과 서비스 워커가
            // 각자 캐시를 가지면 **지금 어느 쪽 화면을 보고 있는지** 알
            // 수 없습니다. 웹은 `window.TeamFlowShell` 을 보고 등록을
            // 건너뜁니다.
            cacheMode = WebSettings.LOAD_DEFAULT
            // 화면 크기를 폰에 맞춥니다. 끄면 데스크톱 폭으로 그려집니다.
            useWideViewPort = true
            loadWithOverviewMode = false
            // 평문 HTTP 를 막습니다. 막히는 것이 회의 음성입니다.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)

        web.webViewClient = ShellWebViewClient()
        web.webChromeClient = ShellChromeClient()

        // ⚠️ 브리지는 **우리 서버 페이지에만** 붙어 있어야 합니다.
        // 바깥 주소는 `shouldOverrideUrlLoading` 이 외부 브라우저로
        // 보내므로 여기 붙을 일이 없지만, 리다이렉트로 끌려가는 경우가
        // 있어 `onPageStarted` 에서 한 번 더 확인합니다.
        web.addJavascriptInterface(ShellBridge(applicationContext), ShellBridge.NAME)

        // 뒤로가기를 웹 히스토리에 연결합니다. 안 하면 첫 뒤로가기에
        // **앱이 그대로 닫히고**, 녹음 중이었다면 그게 곧 트랙 손실입니다.
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
                }
            },
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (savedInstanceState == null) {
            web.loadUrl(getString(R.string.server_url))
        } else {
            web.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        // 앱이 완전히 닫히면 서비스도 내립니다. 안 그러면 녹음이 끝난
        // 뒤에도 알림이 남아 사람이 "아직 듣고 있나" 하고 의심합니다.
        RecordingService.stop(this)
        web.destroy()
        super.onDestroy()
    }

    private inner class ShellWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(view, url, favicon)

            val home = Uri.parse(getString(R.string.server_url))
            val here = Uri.parse(url)
            if (here.host != home.host) {
                // 리다이렉트로 남의 오리진에 끌려갔다. 브리지를 떼어
                // **그 페이지가 셸 기능을 부르지 못하게** 합니다.
                view.removeJavascriptInterface(ShellBridge.NAME)
                Log.w(TAG, "우리 서버가 아닌 곳이라 브리지를 뗍니다: ${here.host}")
                return
            }
            view.addJavascriptInterface(ShellBridge(applicationContext), ShellBridge.NAME)
        }

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean {
            val target = request.url
            val home = Uri.parse(getString(R.string.server_url))

            // 우리 서버 안이면 WebView 가 계속 엽니다.
            if (target.host == home.host) return false

            // 바깥 주소는 **셸 안에서 열지 않습니다.** GitHub 링크를
            // 셸에서 열면 주소창이 없어서 사람이 지금 어디에 있는지
            // 알 수 없습니다 — 그 상태로 로그인 화면이 나오면 피싱과
            // 구분되지 않습니다.
            startActivity(Intent(Intent.ACTION_VIEW, target))
            return true
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (!request.isForMainFrame) return
            // 흰 화면 대신 우리 화면을 보여줍니다. 흰 화면이면 사람은
            // 앱이 죽었다고 생각합니다.
            Log.w(TAG, "화면을 열지 못했습니다: ${request.url} (${error.description})")
            view.loadUrl("file:///android_asset/offline.html")
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            val wantsMicrophone =
                request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
            if (!wantsMicrophone) {
                // 카메라 등은 이 앱이 쓰지 않습니다. 조용히 거절합니다.
                request.deny()
                return
            }

            val already =
                ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.RECORD_AUDIO,
                ) == PackageManager.PERMISSION_GRANTED

            if (already) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                return
            }

            pendingWebRequest = request
            askMicrophone.launch(Manifest.permission.RECORD_AUDIO)
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            pendingWebRequest = null
        }

        /**
         * 웹 콘솔을 안드로이드 로그로 넘깁니다.
         *
         * 셸 안에서는 개발자 도구를 열 수 없어서, 이게 없으면 웹 쪽
         * 오류가 **어디에도 안 남습니다.** 이 저장소의 결함은 거의 전부
         * 예외를 내지 않으므로 로그가 유일한 흔적입니다.
         */
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            val line = "${message.message()} (${message.sourceId()}:${message.lineNumber()})"
            when (message.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG_WEB, line)
                ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG_WEB, line)
                else -> Log.i(TAG_WEB, line)
            }
            return true
        }
    }

    companion object {
        private const val TAG = "TeamFlowShell"
        private const val TAG_WEB = "TeamFlowWeb"
    }
}
