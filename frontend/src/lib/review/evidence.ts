/**
 * 근거 발화 — **원문과 그 원문을 얼마나 믿을 수 있는가** (docs/19 §24).
 *
 * 이 제품의 대표 주장은 "기여도 숫자에서 출발해 어느 회의 몇 번째
 * 발언까지 거슬러 올라갈 수 있다" 입니다. 오랫동안 화면은 `근거 #5` 라고
 * **적기만** 했습니다 — 그 번호로 원문을 가져올 엔드포인트가 없었고,
 * 눌러도 아무 데도 못 갔습니다.
 *
 * 판단은 전부 여기 있습니다. 화면(`demo/evidence.tsx`)은 그리기만 합니다.
 */

import { describeType } from './labels.ts';
import { atText } from './minutes.ts';

/** 서버가 주는 발화 한 줄 (`GET /api/meetings/{id}/utterances`). */
export interface Utterance {
  id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker_id: number | null;
  speaker_name: string | null;
  /** `track` · `voiceprint` · `manual` · `diarization` */
  speaker_source: string;
  speaker_confidence: number | null;
  is_overlap: boolean;
  utterance_type: string | null;
}

/** 화면에 그릴 한 줄. */
export interface EvidenceView {
  id: number;
  /** `0:32` — 근거가 없으면 `null`. 시각을 지어내지 않습니다. */
  at: string | null;
  text: string;
  /** 누가 말했나. 못 정했으면 그렇게 말합니다. */
  speaker: string;
  /**
   * 그 화자 판정을 얼마나 믿을 수 있는가.
   *
   * ⚠️ **`null` 이 아니면 반드시 화면에 나와야 합니다.** 멀티트랙으로
   * 확정된 화자와 미매핑 화자는 "누가 말했다" 의 무게가 완전히 다릅니다.
   * 출처를 감추면 추측한 화자를 사실처럼 읽게 됩니다.
   */
  speakerNote: string | null;
  /** 동시에 말한 구간인가. 발언량 계산이 흔들리는 자리입니다. */
  overlap: boolean;
  /**
   * 무슨 발언인가 — `제안` · `반대 의견` 처럼 사람 말로.
   *
   * ⚠️ 아직 분류 전이면 `null` 입니다. 서버는 이 값을 오래전부터 보내고
   * 있었는데 **화면이 안 쓰고 있었습니다**(대표 실패 ①). 이게 보여야
   * 사람이 잘못 매겨진 라벨을 발견하고 고칠 수 있습니다 — 규칙 기반
   * 분류기는 틀리고, 틀린 것을 아무도 못 보면 영영 안 고쳐집니다.
   */
  type: string | null;
}

/** `?ids=` 에 실을 문자열. 빈 목록이면 요청 자체를 보내지 않게 `''`. */
export function evidenceQuery(ids: readonly number[]): string {
  return [...new Set(ids)].filter((n) => Number.isSafeInteger(n) && n > 0).join(',');
}

/**
 * 화자 판정의 출처를 사람 말로.
 *
 * ⚠️ `track` 은 **아무 말도 하지 않습니다.** 멀티트랙은 이 제품의 기본
 * 전제라 그게 정상이고, 정상에 꼬리표를 달면 나머지 셋이 안 보입니다.
 */
const UNRESOLVED = '화자를 확정하지 못했습니다 — 목소리로 나눈 것까지입니다';

export function speakerNote(source: string, confidence: number | null): string | null {
  if (source === 'track') return null;
  if (source === 'manual') return '사람이 지정한 화자입니다';
  if (source === 'voiceprint') {
    return confidence === null
      ? '목소리로 추정한 화자입니다'
      : `목소리로 추정한 화자입니다 (유사도 ${Math.round(confidence * 100)}%)`;
  }
  if (source === 'diarization') return UNRESOLVED;
  // ⚠️ 모르는 값. 조용히 "확정" 으로 그리지 않습니다 — 그쪽이 훨씬 위험합니다.
  //
  // ⚠️ **여기로 떨어지는 것은 임시 안전망이지 답이 아닙니다.** 서버가
  //    저장할 수 있는 값(`backend/teamflow/db/vocab.py` 의 `STORED`)은
  //    **전부 위에 제 가지를 가져야 합니다** — 백엔드 검사가 그걸 봅니다.
  //    예컨대 영상 융합이 열리면 `fused` 는 오디오·영상이 **일치한** 것이라
  //    여기 문구("확정하지 못했습니다")가 정반대가 됩니다.
  return UNRESOLVED;
}

export function evidenceView(utterance: Utterance): EvidenceView {
  return {
    id: utterance.id,
    at: atText(utterance.start_ms),
    text: utterance.text,
    // ⚠️ 이름이 없으면 **지어내지 않습니다.** `사용자 #3` 같은 것도
    // 안 씁니다 — 그건 사람 이름처럼 읽힙니다.
    speaker: utterance.speaker_name ?? '화자 미확정',
    speakerNote: speakerNote(utterance.speaker_source, utterance.speaker_confidence),
    overlap: utterance.is_overlap,
    // ⚠️ 아직 분류 안 한 발화는 `null` 이고, 화면은 **아무 말도 안 합니다.**
    // `기타` 라고 적으면 재고 나서 모르는 것처럼 보입니다 (불변식 3).
    type: describeType(utterance.utterance_type),
  };
}

/**
 * 물어본 것 중 **못 받은 것**에 대해 할 말.
 *
 * ⚠️ 서버는 못 찾은 id 를 조용히 버립니다. 그 사실을 화면이 삼키면,
 * 후보가 **남의 회의 발화를 근거로 달고 있어도** 근거가 하나 적은 것처럼
 * 보일 뿐입니다. 셋을 물었는데 둘이 오면 그렇게 말해야 합니다.
 */
export function missingNote(asked: readonly number[], got: readonly Utterance[]): string | null {
  const found = new Set(got.map((u) => u.id));
  const missing = [...new Set(asked)].filter((id) => !found.has(id));
  if (missing.length === 0) return null;
  return `${missing.length}건은 이 회의에서 찾지 못했습니다 — 다른 회의의 발화를 가리키고 있을 수 있습니다`;
}

/** 아무것도 못 받았을 때. 빈 상자를 띄우지 않습니다. */
export function emptyEvidenceNote(asked: readonly number[]): string {
  return asked.length === 0
    ? '이 후보에는 근거 발화가 없습니다 — 회의에 없던 내용일 수 있습니다'
    : '근거 발화를 찾지 못했습니다 — 목록이 오래됐을 수 있습니다. 새로 고쳐 주세요';
}

/**
 * 근거 발화 **주변**까지 고른다 (수정 지시서 v2 F5).
 *
 * ## 왜
 *
 * 근거 패널이 근거 한 건만 띄우고 있었습니다. 화면 높이 800px 에 내용이
 * 177px, **623px 이 빈 채**였습니다. 그런데 그건 여백 문제만이 아닙니다 —
 * *"금요일까지 만들기로 하죠"* 한 줄만 떼어 놓고 보면 그 말이 **합의인지
 * 반문인지** 알 수 없습니다. 앞뒤가 있어야 사람이 판단할 수 있고, 판단하라고
 * 만든 화면입니다.
 *
 * ## 무엇을 고르나
 *
 * 근거 발화마다 앞 `span` 건 · 뒤 `span` 건. 창이 겹치면 합칩니다 —
 * 근거가 이웃해 있을 때 같은 발화를 두 번 그리지 않기 위해서입니다.
 *
 * ⚠️ **순서는 `all` 이 준 순서 그대로**입니다. 여기서 다시 정렬하면 시간축이
 * 두 벌이 됩니다 (타임라인은 `timeline.ts` 가 정합니다).
 */
export interface ContextPick {
  id: number;
  /** 근거로 지목된 발화인가. 거짓이면 앞뒤 맥락으로 딸려 온 것. */
  isEvidence: boolean;
}

export function withContext(
  all: readonly number[],
  evidence: readonly number[],
  span = 2,
): ContextPick[] {
  if (span < 0) throw new RangeError('span에는 0 이상만 줄 수 있습니다');
  const mark = new Set(evidence);
  // ⚠️ `indexOf` 를 반복문 안에서 부르면 O(n²) 입니다. 회의가 길어지면
  // 발화가 수천이라 자리를 미리 재 둡니다.
  const at = new Map<number, number>();
  all.forEach((id, i) => at.set(id, i));

  const keep = new Set<number>();
  for (const id of evidence) {
    const i = at.get(id);
    // 근거로 적힌 id 가 목록에 없을 수 있습니다 — 지워진 발화, 다른 회의.
    // 그건 `missingNote` 가 말합니다. 여기서는 조용히 건너뜁니다.
    if (i === undefined) continue;
    for (let k = Math.max(0, i - span); k <= Math.min(all.length - 1, i + span); k++) {
      const around = all[k];
      if (around !== undefined) keep.add(around);
    }
  }
  return all.filter((id) => keep.has(id)).map((id) => ({ id, isEvidence: mark.has(id) }));
}
