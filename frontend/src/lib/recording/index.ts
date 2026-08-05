/**
 * 녹음 클라이언트 공개 API.
 *
 * ```
 *   [브라우저 API]        browser-adapter.ts   ← 얇음, 여기서 검증 불가
 *         │
 *         ▼
 *   [조립]               client.ts            ← 어댑터 주입, 전부 검증됨
 *         │
 *         ├── clock.ts         서버 시각 동기화
 *         ├── capture.ts       코덱·제약 선택과 검증
 *         ├── session.ts       상태 머신 (법적 게이트 포함)
 *         ├── upload-queue.ts  청크 업로드·재시도·재개
 *         └── timeline.ts      공백 탐지와 트랙 판정
 *                   │
 *                   ▼
 *         [백엔드] audio/multitrack.py 로 넘어간다
 * ```
 */

export * from './capture.ts';
export * from './clock.ts';
export * from './client.ts';
export * from './session.ts';
export * from './timeline.ts';
export * from './types.ts';
export * from './upload-queue.ts';
