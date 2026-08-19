// 비활성 사유를 **문장이 아니라 조건 칩**으로.
//
// ## 왜 문장을 걷어냈나
//
// 후보 카드 하나가 이런 문장 셋을 이고 있었습니다 —
//
//     회의에서 담당자가 지정되지 않았습니다      (19자)
//     회의에서 마감일이 언급되지 않았습니다      (19자)
//     담당자 · 마감일을 지정해야 등록할 수 있습니다 (24자)
//
// 셋이 **같은 사실**을 세 번 말합니다. 카드가 셋이면 186자입니다. 그리고
// 그 아래 입력칸이 이미 `미지정` 이라고 말하고 있습니다 — 화면에 보이는
// 것을 되풀이하는 문장이 가장 먼저 지울 것입니다.
//
// ## ⚠️ `disabled` 를 쓰지 않습니다
//
// GOV.UK 디자인 시스템은 비활성 버튼을 **되도록 피하라**고 못 박습니다:
// 대비가 낮고, 키보드로 포커스를 줄 수 없고, 낭독기에 아무 사유도 못
// 전합니다. 그래서 `aria-disabled` 를 씁니다 — 탭으로 닿고, "비활성"이라
// 읽히고, `aria-describedby` 로 사유까지 닿습니다.
//
// ⚠️ 그리고 **툴팁으로 감싸지 않습니다.** Shopify Polaris 가 그렇게 했다가
// 툴팁이 첫 포커스 노드가 되어 VoiceOver 가 엉뚱한 것을 읽었고, 결국
// 그 툴팁을 걷어냈습니다. 사유는 툴팁이 아니라 **버튼 옆 실제 DOM 노드**에
// 둡니다.

export interface Condition {
  /** 한 낱말. `담당자`·`마감`·`근거 2` 처럼. */
  label: string;
  met: boolean;
}

interface ConditionsProps {
  items: Condition[];
  /** `aria-describedby` 로 버튼이 가리킬 id. */
  id?: string;
}

export function Conditions({ items, id }: ConditionsProps) {
  if (items.length === 0) return null;
  return (
    <span className="conds" id={id}>
      {items.map((c) => (
        <span key={c.label} className={`cond${c.met ? ' cond--met' : ''}`}>
          {/* ⚠️ 색만으로 가르지 않습니다 — 채운 원과 빈 원은 흑백에서도,
              색각이상에서도 다릅니다. */}
          <span aria-hidden="true">{c.met ? '●' : '○'}</span>
          {c.label}
        </span>
      ))}
    </span>
  );
}

/**
 * 낭독기와 `title` 에 쓸 한 줄. 화면에는 칩이, 여기에는 말이.
 *
 * ⚠️ 예전에는 `…이(가) 아직 채워지지 않아` 였습니다. 칩이 **"비었다" 말고
 * 다른 것**도 말하게 되면서 문장이 깨졌습니다 — `마감 지남이(가) 아직
 * 채워지지 않아`. 라벨에 동사를 붙이지 말고 **그대로 나열**합니다.
 */
export function describeConditions(items: Condition[]): string {
  const missing = items.filter((c) => !c.met).map((c) => c.label);
  if (missing.length === 0) return '등록할 수 있습니다';
  return `아직 안 된 것 — ${missing.join(' · ')}`;
}
