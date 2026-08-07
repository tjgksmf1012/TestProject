/**
 * GitHub 연결 진단 — 화면이 할 말.
 *
 * ## 왜 이 화면이 필요한가
 *
 * `docs/15` §4.2 가 이 시스템의 가장 위험한 실패를 이렇게 적었습니다.
 *
 * > 저장소를 적어 넣어도 웹훅이 오는지, 서명이 맞는지, 설치 id 가
 * > 유효한지 화면에 아무것도 안 나옵니다. **틀리면 오류 없이 기여도만
 * > 빕니다.**
 *
 * 기여도가 비면 사람은 "활동을 안 했구나" 로 읽습니다. 이 값은 성적에
 * 쓰일 수 있으므로, 조용히 0 이 되는 것은 버그가 아니라 **오답**입니다.
 *
 * ## 판단은 서버가 한다
 *
 * 무엇이 문제인지(`code`·`headline`·`next_step`)는 서버의
 * `github/connection.py` 가 정합니다. 화면과 서버가 같은 판단을 두 벌
 * 가지고 있으면 언젠가 갈라지고, 그때 사람은 화면 쪽을 믿습니다.
 *
 * 여기 있는 것은 **표시**에 대한 판단뿐입니다 — 언제 온 배달인지를
 * 사람의 말로 바꾸고, 요청이 실패했을 때 무엇을 말할지 정합니다.
 */

/** 서버 `GithubHealthOut` 과 같은 모양. */
export interface GithubHealth {
  code: string;
  headline: string;
  detail: string;
  severity: string;
  next_step: string | null;
  warnings: string[];
  repo: string | null;
  verified_at: string | null;
  delivery_count: number;
  last_delivery_at: string | null;
}

/** 화면이 그리는 데 필요한 것만. */
export interface HealthView {
  headline: string;
  detail: string;
  /** CSS 클래스로 그대로 씁니다. */
  tone: 'ok' | 'warn' | 'bad';
  nextStep: string | null;
  warnings: string[];
  /** "배달 12건 · 마지막 3분 전" 같은 한 줄. 없으면 빈 문자열. */
  activity: string;
}

const TONES = new Set(['ok', 'warn', 'bad']);

/**
 * 언제 온 배달인지를 사람의 말로.
 *
 * 정확한 시각(`2026-09-01 12:03:44`)은 이 화면에서 쓸모가 없습니다.
 * 사람이 알고 싶은 건 "지금도 오고 있나" 하나입니다.
 */
export function describeLastDelivery(iso: string | null, now: Date): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  // 서버와 기기의 시계가 조금 어긋나면 미래가 나옵니다. "-3초 전" 을
  // 보여주는 대신 방금으로 봅니다 — 시계 차이는 사람이 고칠 것이 아닙니다.
  if (seconds < 60) return '방금';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}

/**
 * 활동 한 줄.
 *
 * ⚠️ 배달이 0건이면 **아무 말도 하지 않습니다.** "배달 0건" 은 위쪽
 * headline 이 이미 하는 말이고, 여기서 또 하면 같은 사실이 두 번
 * 나와서 어느 쪽을 고쳐야 하는지 흐려집니다.
 */
export function describeActivity(health: GithubHealth, now: Date): string {
  if (health.delivery_count <= 0) return '';
  const when = describeLastDelivery(health.last_delivery_at, now);
  const count = `배달 ${health.delivery_count}건`;
  return when ? `${count} · 마지막 ${when}` : count;
}

export function describeHealth(health: GithubHealth, now: Date): HealthView {
  return {
    headline: health.headline,
    detail: health.detail,
    // 서버가 모르는 값을 보내면 **좋은 쪽으로 넘기지 않습니다.** 연결이
    // 정상이라고 잘못 말하는 것이 모른다고 말하는 것보다 나쁩니다.
    tone: (TONES.has(health.severity) ? health.severity : 'warn') as HealthView['tone'],
    nextStep: health.next_step,
    warnings: health.warnings ?? [],
    activity: describeActivity(health, now),
  };
}

/**
 * 진단 자체를 못 불러왔을 때.
 *
 * ⚠️ 여기서 조용히 넘어가면 **연결이 정상인 것처럼 보입니다.** 진단
 * 화면이 비어 있는 것과 "문제 없음" 은 사람 눈에 똑같습니다.
 */
export function describeHealthFailure(status: number): HealthView {
  if (status === 403) {
    return {
      headline: '이 프로젝트의 구성원만 볼 수 있습니다',
      detail: '연결 상태에는 저장소 이름이 들어 있어 팀 밖에는 보여주지 않습니다.',
      tone: 'warn',
      nextStep: null,
      warnings: [],
      activity: '',
    };
  }
  if (status === 0) {
    return {
      headline: '연결 상태를 확인하지 못했습니다',
      detail: '서버에 닿지 못했습니다. 인터넷 연결을 확인하세요.',
      tone: 'warn',
      nextStep: '잠시 뒤 새로고침하세요.',
      warnings: [],
      activity: '',
    };
  }
  return {
    headline: '연결 상태를 확인하지 못했습니다',
    detail: `서버가 HTTP ${status} 로 답했습니다. 연결이 정상이라는 뜻은 아닙니다.`,
    tone: 'warn',
    nextStep: '잠시 뒤 새로고침하세요.',
    warnings: [],
    activity: '',
  };
}
