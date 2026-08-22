import { useMemo, useState } from 'react';
import { teamDateTime } from '@lib/time/calendar.ts';
import { useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { TrackRibbon } from '../components/TrackRibbon.tsx';
import { Chain, type ChainLink } from '../components/Chain.tsx';
import { Stat } from '../components/Stat.tsx';
import { Why } from '../components/Why.tsx';
import { useConfirmFinals, useContributions, useFinals, useMembers } from '../api/hooks.ts';
import { ApiError } from '../api/client.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';
import {
  confidenceRibbon,
  describeTeamRibbon,
  ribbonReading,
  sharedConfidence,
} from '@lib/contribution/ribbon.ts';
import {
  categoriesForDisplay,
  describeCategory,
  describeRange,
  nothingMeasured,
  hasNoEvidence,
  integrityNotes,
  nameOf,
  orderForDisplay,
  readBeforeTheNumber,
  roleOf,
  teamWarnings,
  uncertaintySpans,
  describeWidth,
  describeWidthNote,
  type MemberScore,
  type Person,
} from '@lib/contribution/view.ts';
import {
  adjustmentsToRestore,
  BLIND_CONFIRM,
  describeFinals,
  problemsWith,
  sameValue,
  toPayload,
  type Draft,
} from '@lib/contribution/final.ts';
import { Problem } from '../components/Problem.tsx';

// 기여도 — 세 사람과 확정 폼이 **한 화면에 동시에** 보인다 (지시서 09).
//
// 불변식: 이름순 고정 · 구간(단일 점수 없음) · 결측은 황토 · 확정은 사람이.
// 리본 채움은 **확신도** 비례입니다 — 기여도에 비례하면 그게 순위표입니다.

/**
 * 이 사람의 근거를 **사슬**로 — 회의 → 업무 → 코드.
 *
 * ⭐ 사슬이 여기서 하는 일은 이 제품의 전부입니다: **0건과 못 잼을
 * 가릅니다.** 예전 `코드 4 · 업무 1 · 회의 6` 은 0건 카테고리를 아예
 * 빼 버려서, "한 적 없음" 과 "못 쟀음" 이 화면에서 똑같이 사라졌습니다.
 * 지금은 0 이면 `0` 을 적고, 못 잰 것만 **빈 고리**로 둡니다.
 */
function evidenceChain(member: MemberScore): ChainLink[] {
  const gaps = new Set((member.measurement_gaps ?? []).map((g) => g.category));
  const counts = new Map(categoriesForDisplay(member).map((c) => [c.category, c.event_count]));
  return ['meeting', 'task', 'code'].map((category) => {
    const label = describeCategory(category);
    // ⚠️ **팀 전체에 잰 범주가 하나도 없으면 전부 빈 고리입니다** (결함 191).
    //    `counts` 가 비어 있다고 `0` 을 적으면, 프로젝트를 막 만든 팀의
    //    화면이 `0 회의 · 0 업무 · 0 코드` — "아무것도 안 했다" 가 됩니다.
    //    실제로는 **아직 아무것도 안 이어졌다** 입니다.
    if (nothingMeasured(member)) {
      return { label, value: null, hint: `아직 ${label} 기록을 잰 적이 없습니다 — 0이 아니라 모르는 값입니다` };
    }
    if (gaps.has(category)) {
      return { label, value: null, hint: `${label} 기여를 측정하지 못했습니다 — 0이 아니라 모르는 값입니다` };
    }
    const n = counts.get(category) ?? 0;
    return {
      label,
      value: String(n),
      hint: n === 0 ? `${label} 활동 기록이 0건입니다 — 측정은 됐고, 값이 0입니다` : `${label} 근거 ${n}건`,
    };
  });
}

/* ⛔ 여기서 `new Date(iso).getHours()` 로 그리고 있었습니다 — **브라우저
   달력**입니다. 이 제품의 마감일·달력은 팀 달력(`Asia/Seoul`)이라, 한
   화면에서 달력 두 벌이 섞였습니다(결함 246). 판단은 `@lib`. */
function fmtComputedAt(iso: string): string {
  return teamDateTime(iso) ?? '—';
}

export default function Contributions() {
  const params = useParams();
  const projectId = Number(params['projectId']);
  const score = useContributions(projectId);
  const finals = useFinals(projectId);
  const membersQuery = useMembers(projectId);

  const people: Person[] = useMemo(
    () =>
      (membersQuery.data ?? []).map((m) => ({
        user_id: m.user_id,
        name: m.name,
        role_shares: m.role_shares,
      })),
    [membersQuery.data],
  );

  // 입력 상태 — 칸을 안 건드리면 null(시스템 값 그대로).
  const [values, setValues] = useState<Record<number, string>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [restored, setRestored] = useState(false);
  const confirm = useConfirmFinals(projectId);

  /* ⚠️ **나간 사람은 `people` 에 없습니다** (결함 222). 그 사람의 기록은
     계산에 그대로 들어가므로 줄은 그려지는데, 이름을 못 찾아 「사용자 #3」
     이 뜹니다. 서버가 이름을 같이 보내 주므로 합쳐서 씁니다. */
  const formerPeople = useMemo(() => score.data?.former_members ?? [], [score.data]);
  const everyone = useMemo(() => [...people, ...formerPeople], [people, formerPeople]);

  const members = useMemo(
    () => (score.data ? orderForDisplay(score.data.members, everyone) : []),
    [score.data, everyone],
  );
  const spans = useMemo(() => uncertaintySpans(members), [members]);

  // 남이 조정해 둔 값을 빈칸으로 그리면 다음 확정에서 조용히 지워집니다 (결함 97).
  if (!restored && finals.data && finals.data.finals.length > 0) {
    const restore = adjustmentsToRestore(finals.data.finals);
    if (restore.size > 0) {
      const v: Record<number, string> = {};
      const r: Record<number, string> = {};
      for (const [id, item] of restore) {
        v[id] = String(item.final_value);
        r[id] = item.reason;
      }
      setValues(v);
      setReasons(r);
    }
    setRestored(true);
  }

  const systemValues = useMemo(
    () => new Map(members.map((m) => [m.user_id, m.share])),
    [members],
  );

  const drafts: Draft[] = members.map((m) => {
    const raw = values[m.user_id] ?? '';
    return {
      user_id: m.user_id,
      final_value: raw.trim() === '' ? null : Number(raw),
      reason: reasons[m.user_id] ?? '',
    };
  });
  const problems = problemsWith(drafts, systemValues);
  const changed = drafts.filter(
    (d) =>
      d.final_value !== null &&
      !Number.isNaN(d.final_value) &&
      !sameValue(d.final_value, systemValues.get(d.user_id) ?? NaN),
  );

  // 확정값은 시스템이 아니라 **팀이 적습니다** (v2 F1-4). 빈 칸은 더 이상
  // "시스템 값 그대로"가 아니라 "아직 안 정함"이고, 다 정해야 확정이 열립니다.
  const allFilled =
    members.length > 0 &&
    drafts.every((d) => d.final_value !== null && !Number.isNaN(d.final_value));

  const effectiveSum = drafts.reduce(
    (sum, d) =>
      sum + (d.final_value !== null && !Number.isNaN(d.final_value) ? d.final_value : 0),
    0,
  );
  const sumOff = allFilled && Math.abs(effectiveSum - 100) > 0.05;
  const unfilled = drafts.filter((d) => d.final_value === null || Number.isNaN(d.final_value)).length;

  // 저장된 확정을 모르는 채로 확정하면 남의 조정을 지울 수 있습니다.
  const blind = finals.isError;

  // 확정이 막혀 있다면 **무엇 때문인지** — 값은 아래 사유 문단의 id 입니다.
  // ⚠️ 순서가 곧 우선순위입니다. 빈 칸이 있으면 그것부터 말합니다.
  const confirmBlocked: string | null =
    !allFilled && members.length > 0
      ? 'confirm-unfilled'
      : problems.length > 0
        ? 'confirm-problems'
        : blind
          ? 'confirm-blind'
          : null;

  /** 막힌 버튼을 눌렀을 때 **데려갈 자리**. 알려만 주고 갈 곳이 없으면
   *  이 저장소의 실패 ③(할 일을 알려 주고 그 일을 할 자리를 안 줌)입니다. */
  const focusFirstGap = () => {
    const emptyValue = drafts.find(
      (d) => d.final_value === null || Number.isNaN(d.final_value),
    );
    const target =
      emptyValue !== undefined
        ? `final-${emptyValue.user_id}`
        : (() => {
            const noReason = changed.find((d) => (reasons[d.user_id] ?? '').trim() === '');
            return noReason !== undefined ? `reason-${noReason.user_id}` : null;
          })();
    if (target === null) return;
    const el = document.getElementById(target);
    if (el instanceof HTMLInputElement) {
      el.scrollIntoView({ block: 'center' });
      el.focus();
    }
  };

  if (score.isPending || membersQuery.isPending) {
    return (
      <AppShell title="기여도">
        <div className="panes">
          <section className="pane">
            <div className="pane__body" aria-busy="true" />
          </section>
        </div>
      </AppShell>
    );
  }

  if (score.isError || !score.data) {
    return (
      <AppShell title="기여도">
        <div className="panes">
          <section className="pane">
            <div className="pane__body">
              {/* ⚠️ 예전에는 무슨 일이 있었든 **"네트워크를 확인한 뒤
                  새로고침하세요"** 였습니다. 없는 프로젝트를 열어도 그렇게
                  말했고, 네트워크는 멀쩡한데 사람은 와이파이를 껐다 켰습니다.
                  무엇이 일어났는지에 따라 **할 일이 다릅니다.** */}
              <div className="empty">
                {describeLoadFailure(
                  /* ⚠️ 404 일 때 없는 것은 **기여도가 아니라 프로젝트**
                     입니다 — `/api/projects/{id}/contributions` 가 404 를
                     주는 경우가 그것입니다. "이 기여도를 찾을 수
                     없습니다" 는 사람에게 무엇을 고치라는 말인지 안
                     알려 줍니다. */
                  '프로젝트',
                  score.error instanceof ApiError ? score.error.status : null,
                )}
              </div>
            </div>
          </section>
        </div>
      </AppShell>
    );
  }

  const team = score.data;
  // ⚠️ **나간 사람 이름도 찾을 수 있어야** 합니다 — 「측정 불가」 줄이
  //    그 사람을 부를 수 있습니다 (결함 222).
  const warnings = teamWarnings(team, everyone);
  // 맨 앞에 세울 한 줄 — 「서로 비교하지 마세요」가 이 화면에서 가장 중요한
  // 문장입니다. 없으면(팀 신뢰도가 낮지 않으면) 첫 경고를 세웁니다.
  const headline = warnings.find((w) => w.includes('비교하지 마세요')) ?? warnings[0];
  const teamConfidence = sharedConfidence(members.map((m) => m.confidence));

  return (
    <AppShell
      title="기여도"
      meta={`${team.algo_version} · ${fmtComputedAt(team.computed_at)}`}
    >
      <div className="panes">
        <section className="pane">
          {warnings.length > 0 && (
            /* ⭐ **경고문은 지우지 않습니다** (검수 D). 다만 셋을 한꺼번에
               펼쳐 두면 110px 짜리 글자 벽이 되고, 늘 있는 글자는 배경이
               되어 정작 아무도 안 읽습니다.
               그래서 **가장 중요한 한 줄만** 세워 두고 — 서로를 비교하지
               말라는 그 문장입니다 — 나머지는 `?` 한 번에 원문 그대로. */
            <div className="warnband" role="note">
              <p>
                <strong>⚠</strong> {headline}
              </p>
              <Why about="이 수치를 읽기 전에" lines={warnings} />
            </div>
          )}

          {/* ⭐ 확신도는 **팀 값 하나**입니다 — 사람 줄마다 그리면 팀에 대해
              아는 것을 사람에 대해 아는 것처럼 말하게 됩니다 (결함 248).
              값이 갈라지는 날이 오면 `sharedConfidence` 가 `null` 을 주고
              이 줄은 안 그려집니다. */}
          {teamConfidence !== null && (
            <div className="teamconf">
              <span className="teamconf__who">팀 전체</span>
              <TrackRibbon
                size="md"
                segments={confidenceRibbon(teamConfidence)}
                label={describeTeamRibbon(teamConfidence)}
              />
              <p className="teamconf__read">{ribbonReading(teamConfidence)}</p>
            </div>
          )}

          <div className="pane__body">
            {members.length === 0 ? (
              <div className="empty">
                아직 기여도를 계산할 활동 기록이 없습니다. 회의를 열거나 GitHub
                저장소를 연결하면 여기서 근거와 함께 볼 수 있습니다.
              </div>
            ) : (
              members.map((member) => {
                const span = spans.find((s) => s.userId === member.user_id);
                // ⚠️ `?? 0` 은 **잴 수 없음(null)** 을 0 으로 접습니다 (결함 226).
                const points = span ? span.points : 0;
                const name = nameOf(member.user_id, people, formerPeople);
                // 사유는 **지우지 않고 한 자리에 모읍니다** — 팝오버 안에서
                // 원문 그대로 나옵니다. 요약하면 그게 곧 정보 손실입니다.
                const whyLines = [
                  `신뢰도 ${member.confidence_label} · ${describeWidthNote(points)}`,
                  ...readBeforeTheNumber(member),
                  ...integrityNotes(member),
                  ...(hasNoEvidence(member)
                    ? ['근거가 하나도 없는 숫자입니다 — 활동 기록이 이 사람에게 하나도 붙지 않았습니다.']
                    : []),
                  ...categoriesForDisplay(member)
                    .filter((c) => c.event_count === 0)
                    .map(
                      (c) =>
                        `${describeCategory(c.category)} 활동은 기록이 0건입니다 — 안 한 것인지 측정이 안 닿은 것인지는 팀이 압니다.`,
                    ),
                ];
                return (
                  <article className="crow" key={member.user_id}>
                    <div className="crow__id">
                      <span className="crow__name">{name}</span>
                      <span className="crow__role">{roleOf(member, people)}</span>
                    </div>

                    {/* 구간은 **글자가 주인공**입니다. 레인은 보조이고,
                        카드마다 자기 눈금을 가집니다 (v2 F1 · 조사 R3-4). */}
                    <div className="crow__range-cell">
                      {/* ⛔ **여기에 리본이 있었습니다** (결함 247·248).
                          247: 길이가 기여도에 비례해 세 줄이 막대그래프였습니다.
                          248: 길이를 고쳐 놓고 보니 세 리본이 **완전히 같았고**,
                          그럴 수밖에 없었습니다 — `confidence` 는 팀당 한 번
                          계산되는 값입니다(`contribution/scoring.py`). 팀에
                          대해 아는 것을 사람 이름으로 읽어 주던 것이라
                          **머리말로 한 번만** 올렸습니다. */}
                      <Stat value={describeRange(member)} label="기여 구간" />
                    </div>

                    {/* ⚠️ 예전에는 `신뢰도 낮음 · 모르는 폭 20%p` 였습니다. 앞을
                        떼고 수치만 남긴 이유는 **겹쳐서**가 아닙니다 — 불확실성
                        연구가 말하는 것은 겹침이 해롭다가 아니라, "낮음" 같은
                        **말은 사람마다 다른 확률로 번역된다**는 것입니다. 그래서
                        화면은 잰 값(20%p)을 앞세우고, "낮음" 은 사유 팝오버에
                        둡니다. 근거는 `design/redesign/06-텍스트-최소화-조사.md` R4. */}
                    <Stat value={describeWidth(points)} label="모름" tone="unknown">
                      <Why about={`${name} — 이 숫자를 읽기 전에`} lines={whyLines} />
                    </Stat>

                    {/* 회의 → 업무 → 코드. 0 은 `0`, 못 잰 것만 빈 고리. */}
                    <Chain links={evidenceChain(member)} />
                  </article>
                );
              })
            )}
          </div>

          <div className="confirmbar">
            {/* 예전에는 여기 안내 한 문장(37자)과 아래 비활성 사유 한
                문장(33자)이 **같은 말을 두 번** 하고 있었습니다. 한 줄만
                남기고 전문은 `?` 로. */}
            <p className="confirmbar__notice">
              확정값은 팀이 정합니다
              <Why
                about="확정에 대해"
                lines={[
                  team.notice,
                  ...(finals.data && finals.data.finals.length > 0
                    ? [describeFinals(finals.data.finals, new Map(people.map((p) => [p.user_id, p.name])))]
                    : []),
                ]}
              />
            </p>
            <div className="confirmbar__row">
              {members.map((member) => {
                const name = nameOf(member.user_id, people, formerPeople);
                return (
                  <label className="confirmbar__person" key={member.user_id}>
                    <span className="t13">{name}</span>
                    {/* 단일 점수를 미리 주지 않습니다 — placeholder 는 **구간**입니다
                        (v2 F1-4). 값은 팀이 적고, 적어야 확정이 열립니다. */}
                    <input
                      id={`final-${member.user_id}`}
                      className="input input--num"
                      inputMode="decimal"
                      placeholder={`${describeRange(member)} (시스템 추정)`}
                      aria-label={`${name} 확정값 (%) — 시스템 추정 ${describeRange(member)}`}
                      value={values[member.user_id] ?? ''}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [member.user_id]: e.target.value }))
                      }
                    />
                  </label>
                );
              })}
              <span className="appbar__spacer" />
              {/* ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다 — 검토 화면의
                  `검토 끝내기` 와 같은 규칙입니다. 비활성 버튼은 **초점을 못
                  받아** 낭독기에 사유를 전할 수 없고(GOV.UK), 탭으로 닿지
                  않으니 키보드만 쓰는 사람은 "왜 안 되는지" 를 들을 방법이
                  없습니다. 여기만 HTML `disabled` 로 남아 있었고, 하필 팀이
                  값을 확정하는 이 화면에서 가장 중요한 버튼이었습니다.
                  누르면 아직 안 채운 첫 칸으로 데려다 줍니다. */}
              <button
                type="button"
                className={`btn btn--primary${confirmBlocked !== null ? ' btn--unmet' : ''}`}
                aria-disabled={confirmBlocked !== null || confirm.isPending}
                aria-describedby={confirmBlocked ?? undefined}
                onClick={() => {
                  if (confirm.isPending) return;
                  if (confirmBlocked !== null) {
                    focusFirstGap();
                    return;
                  }
                  confirm.mutate(toPayload(drafts, systemValues));
                }}
              >
                이 값으로 확정
              </button>
            </div>
            {changed.length > 0 && (
              <div className="confirmbar__reasons">
                {changed.map((d) => {
                  const name = nameOf(d.user_id, people, formerPeople);
                  return (
                    <label className="confirmbar__reason" key={d.user_id}>
                      <span className="t12 muted">{name} 조정 사유</span>
                      <input
                        id={`reason-${d.user_id}`}
                        className="input"
                        placeholder="시스템 값과 다르게 정한 이유"
                        value={reasons[d.user_id] ?? ''}
                        onChange={(e) =>
                          setReasons((prev) => ({ ...prev, [d.user_id]: e.target.value }))
                        }
                      />
                    </label>
                  );
                })}
              </div>
            )}
            {!allFilled && members.length > 0 && (
              <Problem id="confirm-unfilled" tone="incomplete">{unfilled}칸 남음</Problem>
            )}
            {/* ⚠️ **꼬리를 여기 붙이지 마십시오.** 여기에 「— 사유 없는
                조정은 …」 이 박혀 있었고, 문제가 하나뿐인 동안은 읽혔습니다.
                범위 문제(결함 215)가 생기자 상관없는 꼬리가 그 뒤에
                붙었습니다. 문장은 문제를 만드는 곳(`problemsWith`)에
                함께 둡니다. */}
            {problems.length > 0 && (
              <Problem id="confirm-problems" tone="incomplete">
                {problems.join(' · ')}
              </Problem>
            )}
            {blind && <Problem id="confirm-blind">{BLIND_CONFIRM}</Problem>}
            {sumOff && (
              <Problem tone="incomplete">
                합계가 <span className="num">{effectiveSum.toFixed(1)}</span> 입니다 — 100이
                아니어도 확정할 수 있지만, 의도한 것인지 확인하세요.
              </Problem>
            )}
            {confirm.isSuccess && (
              <p className="confirmbar__notice" role="status">
                확정했습니다. 시스템 값과 확정값이 함께 기록에 남습니다.
              </p>
            )}
            {/* ⛔ **서버가 준 글자를 그대로 붙이고 있었습니다** (결함 283).
                `ApiError.message` 는 `detail` 이라, 사람에게는 아무 말도
                아닌 문장이 그대로 뜹니다. 게다가 무슨 일이 있었든 같은
                꼴이라 **할 일**을 말해 주지 못합니다 — 409(남이 먼저
                확정함)와 403(권한 없음)에 필요한 말이 서로 다릅니다.
                문구는 `@lib` 한 벌입니다. */}
            {confirm.isError && (
              <Problem>
                {describeActionFailure(
                  '기여도 확정',
                  confirm.error instanceof ApiError ? confirm.error.status : null,
                  confirm.error instanceof ApiError ? confirm.error.detail : null,
                )}
              </Problem>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
