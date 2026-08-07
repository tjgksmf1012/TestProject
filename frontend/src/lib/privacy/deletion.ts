/**
 * 내 녹음 지우기 — 화면이 할 말.
 *
 * ## 왜 이게 로직인가
 *
 * `POST /api/projects/{id}/me/data` 는 만들었는데 **부르는 화면이 없었습니다.**
 * 이 저장소에서 가장 자주 나온 결함이 그것이고, 이번에는 제가 직접
 * 만들었습니다. 엔드포인트가 있는 것과 사람이 권리를 행사할 수 있는 것은
 * 다릅니다 — 화면이 없으면 여전히 개발자에게 부탁해야 합니다.
 *
 * ## 어렵게 만들지 않는다
 *
 * ⚠️ 이건 **법적 권리**입니다(개인정보보호법 제36조). 위험한 관리자
 * 동작이 아닙니다. "DELETE 를 입력하세요" 같은 장치를 붙이고 싶어지지만,
 * 권리 행사에 마찰을 넣는 것은 그 자체로 어두운 패턴입니다.
 *
 * 대신 **분명하게** 만듭니다. 되돌릴 수 없다는 것, 무엇이 지워지고 무엇이
 * 남는지, 그리고 **기여도에 무슨 일이 일어나는지**를 누르기 **전에**
 * 말합니다. 그걸 알고도 누르면 그건 정보에 근거한 결정입니다.
 *
 * ## 결과를 숨기지 않는다
 *
 * 지우면 그 사람의 회의 기여는 **측정 불가**가 됩니다(0점이 아닙니다 —
 * `docs/05` §5). 그건 불이익도 이익도 아니지만, **모르고 누르면 안 되는
 * 일**입니다. 나중에 기여도 화면에서 자기 이름 옆에 "측정하지 못했습니다"
 * 를 보고 놀라면 안 됩니다.
 */

/** 서버 `RevokeOut` 과 같은 모양. */
export interface RevokeResult {
  deleted_assets: number;
  revoked_voiceprints: number;
  freed_bytes: number;
  failed: Record<string, string>;
  kept: string[];
  message: string;
}

/**
 * 누르기 **전에** 보여줄 것.
 *
 * 순서가 중요합니다 — 지워지는 것부터 말하고, 남는 것을 말하고,
 * 마지막에 결과를 말합니다. 남는 것을 먼저 말하면 안심시키는 글이 됩니다.
 */
export function whatGetsDeleted(): string[] {
  return [
    '내 목소리가 녹음된 원본 파일 (이 프로젝트의 모든 회의)',
    '내 성문 — 목소리로 나를 알아보는 데 쓰는 데이터',
  ];
}

export function whatRemains(): string[] {
  return [
    '회의록의 발화 텍스트 — 다른 참석자의 회의록이기도 합니다',
    '칸반 업무와 GitHub 활동 기록 — 음성이 아니라 작업 기록입니다',
  ];
}

/**
 * ⭐ 기여도에 무슨 일이 일어나는가.
 *
 * 이걸 안 말하면 나중에 기여도 화면에서 자기 이름 옆에 "측정하지
 * 못했습니다" 를 보고 놀라게 됩니다. **0점이 된다고 쓰면 안 됩니다** —
 * 그건 사실이 아니고, 사람을 겁줘서 권리 행사를 막는 것입니다.
 */
export function whatHappensToMyScore(): string {
  return (
    '아직 처리되지 않은 회의는 발언량을 잴 수 없게 되어 ' +
    '내 회의 기여가 **측정 불가**로 표시됩니다. 0점이 되는 것은 아니고, ' +
    '나머지 활동으로 기여도를 계산합니다. 이미 회의록이 만들어진 회의는 ' +
    '그 텍스트가 남아 있어 그대로 계산됩니다.'
  );
}

/**
 * 확인 대화상자 문구.
 *
 * "정말입니까?" 만 물으면 사람은 무엇을 확인하는지 모른 채 누릅니다.
 * **되돌릴 수 없다는 사실**을 여기 한 번 더 씁니다 — 이게 마지막 지점
 * 입니다.
 */
export function confirmPrompt(): string {
  return (
    '내 녹음 원본과 성문을 지웁니다.\n\n' +
    '되돌릴 수 없습니다. 회의록의 발화 텍스트는 남습니다.\n\n' +
    '계속할까요?'
  );
}

/** 사람이 읽을 크기. `0.0MB` 대신 `없음` 이라고 씁니다. */
export function describeFreed(bytes: number): string {
  if (bytes <= 0) return '없음';
  if (bytes < 1024) return `${bytes}바이트`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface DeletionOutcome {
  /** 사람에게 보여줄 문구 */
  text: string;
  /** 다시 시도해야 하는가 */
  needsRetry: boolean;
  /** 실제로 무언가 지워졌는가 */
  deletedSomething: boolean;
}

/**
 * 끝난 뒤에 할 말.
 *
 * ⭐ **일부 실패를 성공으로 뭉뚱그리지 않습니다.** 다섯 중 셋만 지워졌는데
 * "지웠습니다" 라고 하면, 사람은 남은 둘이 있다는 걸 영영 모릅니다.
 *
 * ⭐ **0건을 성공으로만 답하지 않습니다.** "지울 녹음이 없습니다" 와
 * "지웠습니다" 는 완전히 다른 사실입니다. 이 저장소에서 반복해서 나온
 * "없는 것을 빈 것으로 답하는" 결함입니다.
 */
export function describeOutcome(result: RevokeResult): DeletionOutcome {
  const failedCount = Object.keys(result.failed ?? {}).length;

  if (failedCount > 0) {
    return {
      text:
        `${failedCount}건을 지우지 못했습니다. 남아 있는 것은 그대로입니다 — ` +
        '다시 시도해 주세요. 계속 실패하면 팀에 알려 주세요.',
      needsRetry: true,
      deletedSomething: result.deleted_assets > 0,
    };
  }

  if (result.deleted_assets === 0 && result.revoked_voiceprints === 0) {
    return {
      text: '지울 녹음이 없습니다. 이 프로젝트에 남아 있던 내 음성 자료가 없습니다.',
      needsRetry: false,
      deletedSomething: false,
    };
  }

  const parts: string[] = [];
  if (result.deleted_assets > 0) parts.push(`녹음 원본 ${result.deleted_assets}건`);
  if (result.revoked_voiceprints > 0) {
    parts.push(`성문 ${result.revoked_voiceprints}건`);
  }
  return {
    text:
      `${parts.join('과 ')}을 지웠습니다 (${describeFreed(result.freed_bytes)} 확보). ` +
      '되돌릴 수 없습니다.',
    needsRetry: false,
    deletedSomething: true,
  };
}

/**
 * 실패했을 때 — HTTP 층에서.
 *
 * 조용히 넘어가면 사람은 지워진 줄 압니다. 그게 이 화면에서 가장
 * 나쁜 실패입니다.
 */
export function describeRequestFailure(status: number, detail?: string): string {
  if (status === 401) return '로그인이 풀렸습니다. 다시 로그인한 뒤 시도하세요.';
  if (status === 403) return '이 프로젝트의 구성원만 요청할 수 있습니다.';
  if (status === 0) return '서버에 연결하지 못했습니다. 아무것도 지워지지 않았습니다.';
  return (
    (detail || `요청이 실패했습니다 (HTTP ${status})`) +
    '. 아무것도 지워지지 않았을 수 있습니다 — 다시 확인해 주세요.'
  );
}
