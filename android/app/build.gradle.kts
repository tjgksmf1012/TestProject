plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.teamflow.shell"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.teamflow.shell"
        // 24 = Android 7.0. 이보다 아래는 WebView 의 getUserMedia 가
        // 신뢰할 수 없고, 그 기기로 회의를 녹음할 일도 없다.
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            // 셸에는 줄일 코드가 거의 없다. 켜면 WebView 브리지의
            // @JavascriptInterface 메서드가 사라질 위험만 생긴다.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // 오프라인 화면을 앱 안에 넣는다. 서버에 못 닿을 때 보여줄 것이라
    // 서버에서 받아올 수 없다.
    sourceSets["main"].assets.srcDirs("src/main/assets")
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
}

/**
 * 오프라인 화면을 웹 쪽에서 가져온다.
 *
 * ⚠️ 손으로 복사해 두면 **반드시 갈라집니다.** 웹 쪽 문구를 고쳤는데
 * 셸은 옛 문구를 보여주고, 아무도 모릅니다 — 연결이 끊겼을 때만 뜨는
 * 화면이라 평소에는 눈에 안 띕니다.
 */
val copyOfflinePage by tasks.registering(Copy::class) {
    from(rootProject.file("../frontend/public")) {
        include("offline.html")
        include("app.css")
        include("icon.svg")
    }
    into(layout.projectDirectory.dir("src/main/assets"))
}

tasks.named("preBuild") { dependsOn(copyOfflinePage) }
