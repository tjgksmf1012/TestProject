import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// SPA 는 /app/ 아래에 삽니다 — 기존 페이지(index.html 녹음, call.html 통화,
// 레거시 6화면)와 자리가 겹치지 않습니다.
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // ⚠️ 판단은 한 벌 — 기존 프런트의 검증된 순수 로직을 그대로 씁니다.
      // 여기 복사해 오면 두 벌이 되고, 두 벌이 되면 한쪽만 고쳐집니다.
      '@lib': fileURLToPath(new URL('../frontend/src/lib', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://127.0.0.1:8811' },
  },
  build: { outDir: 'dist' },
});
