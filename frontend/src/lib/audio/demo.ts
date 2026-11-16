export interface DemoScriptLine {
  speaker: string;
  text: string;
  start_sec: number;
  end_sec: number;
}

export interface DemoScriptPreset {
  key: 'sprint' | 'arch';
  label: string;
  script: string;
}

export const DEMO_SCRIPT_PRESETS: readonly DemoScriptPreset[] = [
  {
    key: 'sprint',
    label: '예시: 스프린트 회의',
    script:
      '이팀장: 다음 주 화요일 배포를 위해서 금요일까지 OAuth 로그인 API 구현을 마무리합시다.\n' +
      '김민수: 네, 금요일까지 OAuth 로그인 연동과 테스트 코드 작성을 맡을게요.\n' +
      '박지원: 그럼 토요일까지 DB 마이그레이션 스크립트를 작성하고 검토하겠습니다.\n' +
      '이팀장: 배포 방식은 무중단 배포로 확정하겠습니다.',
  },
  {
    key: 'arch',
    label: '예시: 아키텍처 논의',
    script:
      '박지원: 동시 접속자 증가에 대비해 세션 캐시 레이어를 도입하기로 결정합시다.\n' +
      '이팀장: 동의합니다. Redis 캐시 설정은 화요일까지 구현하겠습니다.\n' +
      '김민수: 저는 장애 복구 시나리오 테스트를 금요일까지 검토하겠습니다.',
  },
];

export type ParsedScript =
  | { ok: true; lines: DemoScriptLine[] }
  | { ok: false; message: string };

export function parseDemoScript(raw: string): ParsedScript {
  const rows = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rows.length || rows.length > 100 || rows.some((line) => !line.includes(':'))) {
    return { ok: false, message: '발언자: 내용 형식으로 1~100줄을 입력해 주세요' };
  }
  return {
    ok: true,
    lines: rows.map((line, index) => {
      const colon = line.indexOf(':');
      return {
        speaker: line.slice(0, colon).trim(),
        text: line.slice(colon + 1).trim(),
        start_sec: index * 5,
        end_sec: (index + 1) * 5,
      };
    }),
  };
}

export function similarityPercent(similarity: number | undefined): number {
  if (similarity === undefined || !Number.isFinite(similarity)) return 0;
  return Math.max(0, Math.min(100, Math.round(((similarity + 1) / 2) * 100)));
}
