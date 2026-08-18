import clsx from 'clsx';
import { describeMeetingStatus } from '@lib/home/next.ts';

// 회의 상태 칩 — 정보를 색으로만 주지 않습니다: 모양(아이콘) + 라벨 동반.
// needs_review 만 인디고(실행 가능), failed 는 황토(측정 못 함) — 빨강 아님.
// 라벨은 lib 의 서버 어휘 짝(`describeMeetingStatus`)에서 옵니다.

const CLASS: Record<string, string> = {
  pending: 'status--open',
  queued: 'status--processing',
  processing: 'status--processing',
  needs_review: 'status--review',
  confirmed: 'status--done',
  failed: 'status--failed',
};

function Icon({ status }: { status: string }) {
  switch (status) {
    case 'queued':
    case 'processing':
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1 A4 4 0 0 1 9 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'needs_review':
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <circle cx="5" cy="5" r="4.4" fill="currentColor" />
        </svg>
      );
    case 'confirmed':
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5.5 L4 8 L8.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'failed':
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1 L9.4 8.6 L0.6 8.6 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    default:
      // pending 과 모르는 상태 — 빈 원. 모르는 상태도 숨기지 않습니다.
      return (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
  }
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={clsx('status', CLASS[status] ?? 'status--open')}>
      <Icon status={status} />
      {describeMeetingStatus(status)}
    </span>
  );
}
