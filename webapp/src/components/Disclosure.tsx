import type { ReactNode } from 'react';

// 설명문은 지우지 않고 접습니다 (R7 · 검수 B 마지막 항목).
// 처음 온 사람은 펼쳐 읽고, 매일 쓰는 사람은 접힌 채 지나갑니다.

interface DisclosureProps {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function Disclosure({ summary, children, defaultOpen }: DisclosureProps) {
  return (
    <details className="disc" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="disc__body">{children}</div>
    </details>
  );
}
