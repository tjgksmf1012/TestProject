/**
 * 보고서를 화면과 **글자**로 옮기는 판단.
 *
 * ## ⚠️ 왜 이게 lib 에 있는가
 *
 * 보고서에는 복사 버튼이 있습니다. 그리고 이 저장소는 복사에 대해 이미
 * 한 번 배웠습니다 — **복사는 화면 글자가 아니라 데이터에서 와야 합니다**
 * (설정 화면의 초대 코드). 화면 글자에서 긁으면 줄바꿈·말줄임·아이콘이
 * 섞여 들어가고, 무엇보다 **화면에 안 보이는 것은 안 따라갑니다.**
 *
 * 여기서 안 따라가면 안 되는 것이 하나 있습니다: **팀 경고**입니다.
 * "이 수치로 서로를 비교하지 마세요" 가 빠진 채로 숫자만 복사돼 나가면,
 * 이 제품이 지키려던 것이 문서 밖으로 사라집니다. 그래서 글자로 옮기는
 * 일을 화면에 두지 않고 여기 두고 테스트를 붙였습니다.
 *
 * ## ⚠️ 순서를 여기서 다시 정하지 않습니다
 *
 * 사람 순서는 **서버가 이미 이름 순으로** 세워서 줍니다
 * (`backend/teamflow/reports/blocks.py`). 화면이 다시 정렬하면 판단이 두
 * 곳이 되고, 언젠가 한쪽이 점수 순이 됩니다. 여기서는 받은 순서를 그대로
 * 씁니다 — 그리고 `guards` 가 "화면이 정렬하지 않는가" 를 봅니다.
 */

import { teamDateOf } from '../time/calendar.ts';

/** 서버가 준 블록. 구조는 `backend/teamflow/reports/__init__.py` 머리말. */
export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'facts'; items: Fact[] }
  | { kind: 'list'; items: string[]; empty_note: string }
  | { kind: 'people'; people: Person[] }
  | { kind: 'gap'; text: string };

export interface Fact {
  label: string;
  value: string;
  gap: boolean;
  note?: string;
}

export interface Person {
  name: string;
  role: string;
  measured: boolean;
  range_low: number | null;
  range_high: number | null;
  confidence: number | null;
  confidence_label: string | null;
  reasons: string[];
  evidence_count: number;
  gaps: string[];
  final_value: number | null;
  final_reason: string | null;
}

export interface ReportContent {
  schema: number;
  report_type: string;
  title: string;
  notices: string[];
  blocks: Block[];
}

export interface ReportSummary {
  id: number;
  report_type: string;
  title: string;
  meeting_id: number | null;
  period_start: string | null;
  period_end: string | null;
  generated_at: string;
}

/** 이 화면이 아는 내용 판. 서버가 더 큰 판을 주면 그렇다고 말해야 합니다. */
export const KNOWN_SCHEMA = 1;

const TYPE_LABEL: Record<string, string> = {
  meeting_minutes: '회의록',
  weekly: '주간 보고서',
  final: '최종 보고서',
};

/**
 * 종류 이름.
 *
 * ⚠️ 모르는 종류를 **빈 글자로 만들지 않습니다.** 빈 글자는 목록에서
 * "이름 없는 보고서" 로 보이고, 사람은 그게 고장인지 원래 그런지 모릅니다.
 */
/**
 * 보고서가 하나도 없을 때 **뭐라고 적고 어디로 보낼 것인가**.
 *
 * ## ⛔ 회의가 0개인 팀에게 「회의 로비에서 회의록을 만드세요」 (결함 312)
 *
 * 갓 만든 프로젝트에서 이 화면이 이렇게 말했습니다 —
 *
 *     아직 만든 보고서가 없습니다
 *     보고서는 자동으로 생기지 않습니다 — 팀이 필요할 때 만듭니다.
 *     위의 [최종 보고서 만들기]를 누르거나, **회의 로비에서 회의록을 만드세요.**
 *
 * 그 팀에는 회의가 **0개**입니다. 같은 화면 옆줄이 스스로
 * 「아직 연 회의가 없습니다 — 설정에서 엽니다」라고 적고 있었는데,
 * 빈 상자는 그것을 안 보고 상수를 뱉었습니다.
 *
 * ⚠️ **결함 294 와 같은 모양입니다** — 「무엇이 비었나」는 맞았고 거짓말은
 * 「다음에 뭘」이었습니다. 294 는 달력, 306 은 로비의 회의록 단추,
 * 이번은 보고서입니다. 그리고 294 때 적어 둔 그대로,
 * **화면이 이미 쥐고 있는 것으로 정할 수 있어야** 합니다 — 그래서
 * 화면이 회의 수를 받아 옵니다.
 */
export interface ReportsEmpty {
  what: string;
  why: string;
  how: string;
}

export function emptyReports(
  /** 이 프로젝트의 회의 수. **모르면 `null`** — 모르는 것을 0 이라고 하지 않습니다. */
  meetingCount: number | null,
): ReportsEmpty {
  const what = '아직 만든 보고서가 없습니다';
  const why = '보고서는 자동으로 생기지 않습니다 — 팀이 필요할 때 만듭니다.';
  if (meetingCount === 0) {
    return {
      what,
      why,
      // 갈 곳이 없는 길은 아예 안 적습니다. 대신 **여기서 되는 것**을 적습니다.
      how: '위의 [최종 보고서 만들기]를 누르세요. 회의록은 회의를 연 뒤에 로비에서 만듭니다 — 아직 연 회의가 없습니다.',
    };
  }
  return {
    what,
    why,
    how: '위의 [최종 보고서 만들기]를 누르거나, 회의 로비에서 회의록을 만드세요.',
  };
}

export function describeReportType(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

/**
 * 화면이 이 내용을 그릴 수 있는가.
 *
 * ⚠️ 모르는 판을 조용히 그리면 **빈 화면**이 나오고, 그건 "보고서가
 * 비었다" 로 읽힙니다. 못 그린다는 것과 빈 것은 다릅니다.
 */
export function tooNewToRender(content: { schema?: number }): boolean {
  return typeof content.schema === 'number' && content.schema > KNOWN_SCHEMA;
}

/**
 * 구간을 글자로.
 *
 * ⚠️ **못 잰 사람에게 0 을 쓰지 않습니다.** 폰이 잠겨 녹음이 끊긴 사람을
 * "말을 안 한 사람" 으로 적으면 그건 측정이 아니라 오답입니다.
 */
export function describeRange(person: Person): string {
  if (!person.measured || person.range_low === null || person.range_high === null) {
    return '측정하지 못했습니다';
  }
  return `${person.range_low}% ~ ${person.range_high}%`;
}

/**
 * 신뢰도 한 줄. 못 쟀으면 신뢰도라는 말 자체가 뜻이 없습니다.
 *
 * ## ⚠️ 「팀」을 붙입니다 (결함 344)
 *
 * 이 값은 **팀 하나를 잰 것**입니다 — 서버가 `compute_confidence` 를 팀당
 * 한 번 부르고, 세 사람의 `confidence` 가 소수점까지 같습니다. 그런데
 * 보고서는 그 값을 사람 이름 밑에 그리므로, 범위를 안 적으면 「이 사람의
 * 신뢰도」로 읽힙니다.
 *
 * 두 화면은 이미 범위를 적고 있었습니다 — 레거시는 「팀 신뢰도 낮음」,
 * SPA 는 리본 위에 「팀 전체」. **보고서만 안 적었고**, 그게 팀 밖으로
 * 나가는 문서입니다 (결함 290 — 같은 사실을 말하는 자리를 나란히).
 */
export function describeConfidence(person: Person): string | null {
  if (!person.measured || person.confidence === null) return null;
  const percent = Math.round(person.confidence * 100);
  const label = person.confidence_label ?? '';
  return label === '' ? `팀 신뢰도 ${percent}%` : `팀 신뢰도 ${percent}% (${label})`;
}

/**
 * 사람 이름 밑에 붙는 **팀 공통** 사유 목록의 머리말 (결함 344).
 *
 * 목록 자체는 사람마다 똑같습니다. 머리말이 없으면 네 줄이 그 사람에
 * 대한 지적으로 읽힙니다 — 아래 `personGapsHeading()` 이 그 사람의 것이라고
 * 말하는 것과 **짝**입니다. 두 머리말은 화면과 복사한 글 **양쪽에서**
 * 이 파일 하나를 씁니다 (사본이 있으면 한쪽만 고쳐집니다).
 */
export function teamReasonsHeading(): string {
  return '팀 공통';
}

/**
 * 그 아래 **이 사람만의** 목록 머리말 (결함 344).
 *
 * ⚠️ **위만 이름 붙이면 반쪽입니다.** 두 목록은 잇달아 그려지므로,
 * 위에만 「팀 공통」을 달면 아래 줄까지 그 머리말 아래로 읽힙니다 —
 * 이 저장소에서 제일 흔한 재발 모양입니다(결함 301: 한 갈래만 고치고
 * 옆 갈래를 그대로 둔 것). 렌더해서 보고 알았습니다.
 */
export function personGapsHeading(): string {
  return '이 사람';
}

/**
 * 팀이 확정한 값 한 줄. 계산값과 **다르면 이유가 반드시 따라갑니다.**
 *
 * 서버가 이미 막고 있지만(`blocks.people`), 화면에서 이유를 떨어뜨리면
 * 결과는 같습니다 — 근거 없는 판정이 문서에 남습니다.
 */
export function describeFinal(person: Person): string | null {
  if (person.final_value === null) return null;
  const reason = (person.final_reason ?? '').trim();
  const head = `팀 확정 ${person.final_value}%`;
  return reason === '' ? head : `${head} — ${reason}`;
}

/**
 * 이 사람에 대해 **못 잰 것**들.
 *
 * 빈 배열이면 화면은 아무것도 안 그립니다 — "못 잰 것 없음" 이라고 굳이
 * 적으면 그 줄이 사람마다 붙어 화면이 소음이 됩니다.
 */
export function gapsOf(person: Person): string[] {
  return person.gaps.filter((g) => g.trim() !== '');
}

/**
 * 목록 한 줄에서 **이 보고서를 다른 것과 가르는 부분**.
 *
 * ⚠️ 서버가 주는 `title` 은 종류를 이미 이고 있습니다 —
 * `회의록 — DB 스키마 확정 논의`. 목록에는 종류 칩이 따로 있으므로 그대로
 * 그리면 **"회의록 회의록 — DB 스키마 확정 논의"** 가 됩니다 (렌더해서
 * 봤습니다). 주간은 더 나빠서 날짜까지 세 번 나옵니다 — 칩·제목·기간.
 *
 * 그래서 종류 머리말을 떼고, 남은 것이 옆 칸(`describeWhen`)과 같으면 아예
 * 비웁니다. **지우는 게 아니라 한 번만 보이게** 하는 것입니다.
 */
export function subjectOf(row: ReportSummary): string {
  const prefix = `${describeReportType(row.report_type)} — `;
  const rest = row.title.startsWith(prefix) ? row.title.slice(prefix.length) : row.title;
  return rest.trim() === describeWhen(row).trim() ? '' : rest.trim();
}

/**
 * 목록 한 줄에 붙는 때. `2026-08-03 ~ 2026-08-09` 또는 생성 시각.
 *
 * ⛔ **`instant.slice(0, 10)` 로 자르지 않습니다 — 그건 UTC 달력일입니다**
 * (`time/calendar.ts` 가 그렇게 적어 두었는데 여기만 어기고 있었습니다).
 *
 * 서버는 보고서 **제목**을 팀 달력으로 짓습니다(`reports/period.py`,
 * 결함 290 에서 고쳤습니다). 그런데 이 줄만 UTC 로 잘라서, 같은 보고서
 * 한 줄이 두 주를 말했습니다 (결함 295):
 *
 *     주간 보고서   2026-08-16 ~ 2026-08-22   ← 제목에서 남은 것
 *                  2026-08-15 ~ 2026-08-21   ← 여기
 *
 * ⚠️ 게다가 아래 `subjectOf` 는 **이 값과 제목이 같으면 비우는** 것으로
 * 중복을 막고 있었습니다. 달력이 갈라지면서 그 비교가 조용히 안 맞게
 * 됐고, 그래서 날짜가 두 번 나온 것입니다 — 한 벌이 갈라지면 그것에
 * 기대던 것까지 같이 무너집니다.
 */
export function describeWhen(row: ReportSummary): string {
  if (row.period_start !== null && row.period_end !== null) {
    const from = teamDateOf(row.period_start);
    const to = teamDateOf(row.period_end);
    if (from !== null && to !== null) return `${from} ~ ${to}`;
  }
  const made = teamDateOf(row.generated_at);
  // ⚠️ 못 읽은 시각을 그럴듯한 날짜로 지어내지 않습니다.
  return made === null ? '언제 만든 것인지 모릅니다' : `${made} 만듦`;
}

// ══════════════════════════════════════════════════════════════
// 복사 — **데이터에서** 글자를 만듭니다
// ══════════════════════════════════════════════════════════════

function personLines(person: Person): string[] {
  const lines = [`- ${person.name} (${person.role})`, `  ${describeRange(person)}`];
  const confidence = describeConfidence(person);
  if (confidence !== null) lines.push(`  ${confidence}`);
  if (person.measured) lines.push(`  근거 ${person.evidence_count}건`);
  /* ⚠️ 두 머리말 **다** `@lib` 에서 옵니다. 팀 것은 이미 그랬는데 사람
     것만 `'못 잼'` 이라는 **글자로 박혀** 있었습니다 — 화면은 「이 사람」을
     그리고 복사한 글에는 「못 잼」이 나가, 두 자리가 같은 목록을 다른
     이름으로 부르고 있었습니다. 지금 값이 틀린 것은 아니지만 한쪽만
     고치면 갈라지는 자리라 **사본을 없앱니다**(결함 363 의 방법). */
  for (const reason of person.reasons) lines.push(`  · ${teamReasonsHeading()}: ${reason}`);
  for (const hole of gapsOf(person)) lines.push(`  · ${personGapsHeading()}: ${hole}`);
  const final = describeFinal(person);
  if (final !== null) lines.push(`  ${final}`);
  return lines;
}

function blockLines(block: Block): string[] {
  switch (block.kind) {
    case 'heading':
      return ['', `## ${block.text}`];
    case 'paragraph':
      return [block.text];
    case 'facts':
      return block.items.map((item) => {
        const value = item.gap ? '못 쟀습니다' : item.value;
        const note = (item.note ?? '').trim();
        return note === ''
          ? `${item.label}: ${value}`
          : `${item.label}: ${value} (${note})`;
      });
    case 'list':
      return block.items.length === 0
        ? [block.empty_note]
        : block.items.map((item) => `- ${item}`);
    case 'people':
      // ⚠️ 받은 순서 그대로. 여기서 정렬하면 순서를 정하는 곳이 둘이 됩니다.
      return block.people.flatMap(personLines);
    case 'gap':
      return [block.text];
  }
}

/**
 * 보고서를 통째로 글자로. **복사 버튼이 쓰는 것.**
 *
 * ⚠️ `notices` 를 **맨 위에** 넣습니다. 이게 이 함수의 존재 이유에 가깝습니다 —
 * 숫자만 복사돼 나가면 "이 수치로 서로를 비교하지 마세요" 가 문서 밖으로
 * 사라지고, 받는 사람은 그냥 사람별 퍼센트 목록을 봅니다.
 */
export function toPlainText(content: ReportContent): string {
  const lines: string[] = [`# ${content.title}`];
  for (const notice of content.notices) lines.push(`> ${notice}`);
  for (const block of content.blocks) lines.push(...blockLines(block));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
