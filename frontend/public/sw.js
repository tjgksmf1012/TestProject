/**
 * 서비스 워커 — **앱 껍데기만** 캐시합니다.
 *
 * ## 무엇을 캐시하고 무엇을 캐시하지 않는가
 *
 * 캐시하는 것: HTML·JS·CSS·아이콘. 화면을 그리는 데 필요한 것들입니다.
 * 이게 있으면 지하철에서 앱을 열어도 흰 화면 대신 "연결이 없습니다" 라는
 * **우리 화면**이 뜹니다. 홈 화면에 추가한 앱이 흰 화면을 보여주면 사람은
 * 앱이 죽었다고 생각합니다.
 *
 * ⚠️ **캐시하지 않는 것: `/api/*` 전부.**
 *
 * 이건 성능 판단이 아니라 안전 판단입니다.
 *
 *   · 이 앱이 다루는 것은 **회의 녹취**입니다. 동의를 철회하면 서버가
 *     자료를 지우는데(docs/07 P6), 캐시에 남아 있으면 **지운 뒤에도
 *     폰에서 계속 보입니다.** 지웠다는 말이 거짓이 됩니다.
 *   · 기여도는 성적에 반영될 수 있는 값입니다. 오래된 값을 보여주면
 *     사람은 그게 지금 값인 줄 압니다 — 틀린 숫자를 조용히 보여주는 것이
 *     이 저장소에서 반복해서 나온 결함입니다.
 *   · 로그인 세션은 서버에서 끊을 수 있어야 합니다(`user_sessions`).
 *     응답이 캐시되면 로그아웃한 계정의 화면이 계속 뜹니다.
 *
 * 그래서 API 요청은 **서비스 워커를 그냥 지나갑니다.** 오프라인이면
 * 실패하고, 화면이 그 실패를 말합니다. 그게 맞습니다.
 *
 * ## 버전
 *
 * `CACHE` 이름에 버전을 박습니다. 배포할 때 올리지 않으면 **옛 JS 가
 * 계속 뜹니다** — 서버는 새 코드인데 화면만 옛것이라, 필드 이름이
 * 어긋나서 조용히 실패합니다. `npm run build:demo` 뒤에 올려야 합니다.
 */

const CACHE = 'teamflow-shell-v1';

/**
 * 껍데기. 이게 있으면 오프라인에서도 화면이 뜬다.
 *
 * ## ⚠️ 이 목록은 **손으로 적던 것이었고, 두 번 어긋났습니다**
 *
 * 화면·자산을 새로 만들 때마다 빠뜨렸습니다. 빠뜨려도 **아무 데서도
 * 티가 안 납니다** — 온라인에서는 서버가 주니까 멀쩡하고, 오프라인에서만
 * 그 화면이 안 뜹니다. 그런데 오프라인은 개발 중에 거의 안 겪습니다.
 *
 * 빠져 있던 것 중에는 `/tokens.css` 도 있었습니다. **모든 색·간격·글꼴**
 * 이라, 그것만 없어도 오프라인에서 전 화면이 스타일 없는 흰 문서가 됩니다.
 *
 * 처음에는 가드로 대조하는 것까지만 했는데, 그건 **어긋난 뒤에** 잡는
 * 것입니다. 이제 `npm run build` 가 `public/` 을 세어서 아래를 직접
 * 씁니다 — 애초에 갈라질 자리가 없습니다.
 */
const SHELL = [
  /* <<< 자동 생성 — `npm run build` 가 씁니다. 손으로 고치지 마십시오. */
  '/activity.html',
  '/activity.js',
  '/app.css',
  '/calendar.html',
  '/calendar.js',
  '/call.html',
  '/call.js',
  '/chat.html',
  '/chat.js',
  '/chunk-2BG2ILI2.js',
  '/chunk-4BXKYMUD.js',
  '/chunk-4EUAFZWM.js',
  '/chunk-4N2WSGUL.js',
  '/chunk-6XLEMQOB.js',
  '/chunk-DPTEVHP5.js',
  '/chunk-ENHUCZXL.js',
  '/chunk-FKLUUZLM.js',
  '/chunk-FLPN24SJ.js',
  '/chunk-FZNUQFQE.js',
  '/chunk-IL6JNG3A.js',
  '/chunk-KPFCUBU5.js',
  '/chunk-N343A6OC.js',
  '/chunk-PJRLP5K5.js',
  '/chunk-QBCVWSX2.js',
  '/chunk-QBLJAG2H.js',
  '/chunk-QSDTRTKC.js',
  '/chunk-RUIOCDZD.js',
  '/chunk-SFIKOREG.js',
  '/chunk-TEYSWISG.js',
  '/chunk-TVJLCJGT.js',
  '/chunk-XX4MDJAS.js',
  '/chunk-YD5F53II.js',
  '/contributions.html',
  '/contributions.js',
  '/home.html',
  '/home.js',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/icon.svg',
  '/index.html',
  '/kanban.html',
  '/kanban.js',
  '/lobby.html',
  '/lobby.js',
  '/login.html',
  '/login.js',
  '/main.js',
  '/manifest.webmanifest',
  '/notifications.html',
  '/notifications.js',
  '/offline.html',
  '/project.html',
  '/project.js',
  '/reports.html',
  '/reports.js',
  '/review.html',
  '/review.js',
  '/search.html',
  '/search.js',
  '/tokens.css',
  '/tw.css',
  /* >>> */
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 하나가 없어도 나머지는 넣는다. `addAll` 은 하나만 실패해도
      // 전부 버리는데, 그러면 **설치가 조용히 실패한 채로** 남는다.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(url).catch((error) => {
            console.warn('[sw] 캐시하지 못했습니다:', url, error);
          }),
        ),
      );
      // 새 워커를 기다리지 않고 바로 쓴다. 안 하면 사람이 앱을 완전히
      // 닫았다 열기 전까지 옛 껍데기를 본다.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // GET 이 아닌 것은 손대지 않는다. 동의 제출·녹음 종료·승인이 전부
  // POST 인데, 그걸 가로채면 되돌리기 어려운 실수가 된다.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 다른 오리진은 손대지 않는다.
  if (url.origin !== self.location.origin) return;

  // ⚠️ API 는 지나간다. 위 주석의 이유 — 지운 자료가 폰에 남으면 안 된다.
  if (url.pathname.startsWith('/api/')) return;

  // 청크 업로드·다운로드도 마찬가지.
  if (url.pathname.includes('/tracks/')) return;

  event.respondWith(
    (async () => {
      // 네트워크를 먼저 본다. 껍데기가 바뀌었을 때 옛것을 계속 보여주면
      // 서버와 화면이 어긋난 채로 돈다.
      try {
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;

        // 화면 요청이면 오프라인 안내를 준다. 흰 화면을 보여주면
        // 사람은 앱이 죽었다고 생각한다.
        if (request.mode === 'navigate') {
          const offline = await caches.match('/offline.html');
          if (offline) return offline;
        }
        return new Response('연결이 없습니다', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })(),
  );
});
