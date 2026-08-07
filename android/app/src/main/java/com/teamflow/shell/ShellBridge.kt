package com.teamflow.shell

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface

/**
 * 웹이 셸에게 말을 거는 유일한 통로.
 *
 * ## 왜 이렇게 좁은가
 *
 * `@JavascriptInterface` 로 노출한 메서드는 **그 페이지의 모든
 * 자바스크립트가 부를 수 있습니다.** 우리 코드만 부르는 게 아니라,
 * 페이지에 끼어든 무엇이든 부를 수 있습니다. 그래서 여기 있는 것은
 * 넷뿐이고, 전부 **부작용이 없거나 되돌릴 수 있는 것**입니다.
 *
 *   · `startRecording()` — 알림이 뜬다. 최악의 오용은 알림이 뜨는 것.
 *   · `stopRecording()`  — 알림이 사라진다.
 *   · `isShell()`        — 사실을 답한다.
 *   · `version()`        — 사실을 답한다.
 *
 * 파일 읽기·쿠키 읽기·네트워크 같은 것은 **하나도 없습니다.** 필요해
 * 보여도 넣지 마세요 — WebView 브리지는 안드로이드에서 원격 코드 실행이
 * 나오는 가장 흔한 자리입니다.
 *
 * ## 왜 웹이 알려 줘야 하는가
 *
 * 셸은 지금 녹음 중인지 모릅니다. 마이크가 열린 것은 WebView 안에서
 * 일어나는 일이고, 그걸 셸이 들여다볼 방법이 없습니다. 그래서 웹이
 * 말해 줍니다.
 *
 * 앱을 켜자마자 서비스를 시작하지 않는 이유: 녹음도 안 하는데 "녹음 중"
 * 알림이 계속 떠 있으면, 사람은 그 알림을 **무시하는 법을 배웁니다.**
 * 그러면 진짜 녹음 중일 때도 안 봅니다 (docs/07 §1 — 녹음 사실은
 * 보여야 한다).
 */
class ShellBridge(private val context: Context) {

    @JavascriptInterface
    fun isShell(): Boolean = true

    @JavascriptInterface
    fun version(): String = BuildConfigCompat.VERSION_NAME

    /**
     * 녹음이 시작됐다. 프로세스를 살려 둔다.
     *
     * 여러 번 불려도 안전합니다 — 이미 떠 있으면 알림만 갱신됩니다.
     * 웹 쪽에서 재연결·재시도가 일어나므로 중복 호출은 정상입니다.
     */
    @JavascriptInterface
    fun startRecording() {
        Log.i(TAG, "녹음 시작 — 포그라운드 서비스를 올립니다")
        RecordingService.start(context)
    }

    /**
     * 녹음이 끝났다. 알림을 내린다.
     *
     * ⚠️ 웹이 이걸 안 부르면 알림이 계속 남습니다. 그래도 **녹음이 끊기는
     * 것보다는 낫습니다** — 알림이 남는 것은 눈에 보이고, 끊긴 녹음은
     * 안 보입니다. 그래서 여기서는 안전한 쪽으로 기웁니다.
     */
    @JavascriptInterface
    fun stopRecording() {
        Log.i(TAG, "녹음 종료 — 포그라운드 서비스를 내립니다")
        RecordingService.stop(context)
    }

    companion object {
        const val NAME = "TeamFlowShellBridge"
        private const val TAG = "TeamFlowShell"
    }
}

/** `BuildConfig` 는 빌드가 만들어 주므로, 없을 때를 대비한 얇은 층. */
object BuildConfigCompat {
    const val VERSION_NAME: String = "0.1.0"
}
