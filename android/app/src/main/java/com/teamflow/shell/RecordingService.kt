package com.teamflow.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * **이 셸이 존재하는 이유.**
 *
 * 안드로이드는 화면이 꺼지거나 다른 앱으로 넘어가면 백그라운드 프로세스를
 * 조입니다. 브라우저 탭에서 돌던 `MediaRecorder` 는 그때 멈추고, 멈추는
 * 시점은 기기·제조사 배터리 설정마다 다릅니다. 회의 30분짜리 트랙이
 * 10분에서 끊기면 그 사람의 발화량은 측정된 적이 없는 것이 됩니다 —
 * 그런데 **커버리지 숫자만 보고는 "말을 적게 했다" 와 구분되지 않습니다.**
 *
 * 포그라운드 서비스는 그 조임을 면제받습니다. 대가는 알림이 계속 떠 있는
 * 것인데, 회의 녹음에서는 그게 오히려 맞습니다 — 지금 마이크가 켜져 있다는
 * 사실이 **보여야** 합니다 (docs/07 §1, 녹음 사실의 고지).
 *
 * ## 이 서비스가 오디오를 다루지 않는다
 *
 * 녹음은 WebView 안의 `MediaRecorder` 가 계속합니다. 이 서비스는 그
 * 프로세스를 살려 두는 역할만 합니다. 오디오를 코틀린으로 가져오면
 * 시계 동기화·타임라인·공백 판정을 두 벌 유지해야 하고, 웹 쪽 160개
 * 테스트가 가리키는 코드가 실제로 도는 코드가 아니게 됩니다.
 */
class RecordingService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()

        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE,
        )

        val notification: Notification =
            NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_recording)
                .setContentTitle(getString(R.string.recording_title))
                // ⭐ 무엇을 하고 있는지 정확히 씁니다. "실행 중" 만 쓰면
                // 사람은 마이크가 켜져 있는 줄 모릅니다.
                .setContentText(getString(R.string.recording_text))
                .setOngoing(true)
                // 소리·진동 없이. 회의 중에 울리면 녹음에 들어갑니다.
                .setSilent(true)
                .setContentIntent(open)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // 시스템이 메모리 때문에 죽였다면 **다시 살립니다.** 녹음 중에
        // 죽은 채로 두면 그 뒤 구간이 통째로 빕니다.
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) != null) return

        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL,
                getString(R.string.recording_channel),
                // LOW: 소리·헤드업 없이 상태 표시줄에만. 회의 중에
                // 배너가 튀어나오면 사람이 화면을 건드리게 됩니다.
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.recording_channel_why)
                setShowBadge(false)
            },
        )
    }

    companion object {
        private const val CHANNEL = "teamflow.recording"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            val intent = Intent(context, RecordingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RecordingService::class.java))
        }
    }
}
