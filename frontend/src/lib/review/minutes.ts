/**
 * 회의록 — 요약 말고 나머지 (결함 110·111).
 *
 * ## 무엇이 조용히 사라지고 있었나
 *
 * 파이프라인은 회의에서 셋을 만듭니다.
 *
 *     요약           summary          → 저장됨 · 화면에 나옴
 *     다음 안건       next_agenda      → 저장됨 · **읽는 곳 0곳**
 *     미해결 사안     meeting_events   → 저장됨 · **읽는 곳 0곳**
 *
 * 뒤의 둘은 LLM 이 만들고 `validation` 이 근거까지 확인한 산출물입니다.
 * 그런데 API 가 안 실었고, 그래서 화면도 없었습니다. 오류는 안 납니다 —
 * 회의록의 절반이 DB 에만 남고 아무도 못 봅니다.
 *
 * `models.py` 의 `next_agenda` 주석은 이미 같은 일을 한 번 겪었다고
 * 적어 두었습니다 — **&#34;`_serialize` 에 없어서 파이프라인 밖으로 나온
 * 적이 없었다&#34;**. 그때는 파이프라인 → DB 구간을 이었고, DB → 화면
 * 구간이 그대로 남아 있었습니다. **사슬은 한 칸만 끊겨도 끊긴 것입니다.**
 *
 * ## 왜 여기(순수 함수)에 있는가
 *
 * 화면 코드에는 자동 테스트가 없습니다. 그래서 &#34;무엇을 보여줄지&#34; 는
 * 전부 여기서 정하고, 화면은 결과를 그리기만 합니다.
 */

/** 서버 `UnresolvedIssueOut` 과 같은 모양. */
import { evidenceMomentText } from './moment.ts';

export interface UnresolvedIssue {
  content: string;
  /** 언제 나온 얘기인가. 근거가 없으면 둘 다 0 — 시각을 지어내지 않는다. */
  start_ms: number;
  end_ms: number;
  evidence_utterance_ids: number[];
}

export interface Minutes {
  summary: string | null;
  next_agenda: string[];
  unresolved_issues: UnresolvedIssue[];
}

/**
 * `mm:ss`. 근거가 없어 0 인 것은 시각을 만들어 내지 않고 null.
 *
 * ⚠️ **`findings.ts` 에 글자까지 똑같은 사본이 있었습니다** (결함 353).
 * 판단은 `moment.ts` 한 곳입니다.
 *
 * ⛔ **발화 한 줄에는 이걸 쓰지 마십시오** — 발화의 `0` 은 「모른다」가
 * 아니라 「회의 시작과 동시에」입니다. 그쪽은 `momentText` 입니다.
 */
export const atText = evidenceMomentText;

export interface IssueView {
  content: string;
  /** `2:05` 또는 null. null 이면 화면이 시각 칸을 아예 안 그린다. */
  at: string | null;
  /**
   * 근거 발화가 몇 건인가.
   *
   * ⚠️ 0 건도 **보여줍니다.** 숨기면 근거 없는 미해결 사안이 근거 있는
   * 것과 똑같아 보입니다 — 이 저장소는 후보 승인에서 이미 같은 규칙을
   * 씁니다(근거 없는 후보는 승인 불가).
   */
  evidenceCount: number;
}

export function describeIssue(issue: UnresolvedIssue): IssueView {
  return {
    content: issue.content.trim(),
    at: atText(issue.start_ms),
    evidenceCount: (issue.evidence_utterance_ids ?? []).length,
  };
}

/**
 * 화면에 그릴 미해결 사안들.
 *
 * 내용이 빈 것은 뺍니다 — 빈 항목은 &#34;미해결 사안 3건&#34; 이라는 숫자만
 * 부풀리고 사람에게는 아무것도 안 알려 줍니다.
 */
export function issueViews(issues: readonly UnresolvedIssue[]): IssueView[] {
  return issues.map(describeIssue).filter((v) => v.content !== '');
}

/** 다음 안건. 빈 줄과 중복은 뺀다. */
export function agendaItems(agenda: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of agenda) {
    const item = raw.trim();
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 요약 **말고** 보여줄 것이 있는가.
 *
 * 요약은 자기 자리(`#meeting-summary`)가 따로 있습니다. 이 함수가
 * 판단하는 것은 그 아래 회의록 칸을 열지 말지입니다 — 그래서 요약은
 * 일부러 세지 않습니다. 요약까지 세면 **다음 안건도 미해결 사안도
 * 없는 회의에서 빈 상자 두 개가 열립니다.**
 *
 * ⚠️ **처리 전과 &#34;정말 아무것도 안 나왔다&#34; 는 다릅니다.** 이 함수는
 * 그 둘을 구분하지 않습니다 — 없으면 그냥 감춥니다. 회의가 어디까지
 * 갔는지는 이미 후보 목록 쪽이 말하고 있고, 여기서 &#34;다음 안건 없음&#34;
 * 을 띄우면 아직 처리 중인 회의에서 그것이 결과로 읽힙니다.
 */
export function hasExtraMinutes(minutes: Pick<Minutes, 'next_agenda' | 'unresolved_issues'>): boolean {
  return (
    agendaItems(minutes.next_agenda).length > 0 ||
    issueViews(minutes.unresolved_issues).length > 0
  );
}
