import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { TrackRibbon, type RibbonSegment } from '../components/TrackRibbon.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { useConfirmFinals, useContributions, useFinals, useMembers } from '../api/hooks.ts';
import {
  categoriesForDisplay,
  describeCategory,
  describeRange,
  hasNoEvidence,
  integrityNotes,
  nameOf,
  orderForDisplay,
  readBeforeTheNumber,
  roleOf,
  teamWarnings,
  uncertaintySpans,
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

// 기여도 — 세 사람과 확정 폼이 **한 화면에 동시에** 보인다 (지시서 09).
//
// 불변식: 이름순 고정 · 구간(단일 점수 없음) · 결측은 황토 · 확정은 사람이.
// 리본 채움은 **확신도** 비례입니다 — 기여도에 비례하면 그게 순위표입니다.

/** 리본 조각: 왼쪽부터 확신(잉크) → 모르는 폭(빗금) → 빈 곳. */
function ribbonFor(member: MemberScore, widthPoints: number): RibbonSegment[] {
  const known = Math.min(1, Math.max(0, member.confidence));
  const unknown = Math.min(1 - known, widthPoints / 100);
  return [
    { start: 0, end: known, kind: 'known' },
    { start: known, end: known + unknown, kind: 'unknown' },
  ];
}

/** `코드 4 · 업무 1` — 근거 **건수**. 0건 카테고리는 접힌 상세에서 말합니다. */
function countsLine(member: MemberScore): string {
  const parts = categoriesForDisplay(member)
    .filter((c) => c.event_count > 0)
    .map((c) => `${describeCategory(c.category)} ${c.event_count}`);
  return parts.length > 0 ? parts.join(' · ') : '근거 0건';
}

function fmtComputedAt(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

  const members = useMemo(
    () => (score.data ? orderForDisplay(score.data.members, people) : []),
    [score.data, people],
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

  const effectiveSum = drafts.reduce((sum, d) => {
    const system = systemValues.get(d.user_id) ?? 0;
    const v = d.final_value !== null && !Number.isNaN(d.final_value) ? d.final_value : system;
    return sum + v;
  }, 0);
  const sumOff = members.length > 0 && Math.abs(effectiveSum - 100) > 0.05;

  // 저장된 확정을 모르는 채로 확정하면 남의 조정을 지울 수 있습니다.
  const blind = finals.isError;

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
              <div className="empty">
                기여도를 불러오지 못했습니다. 네트워크를 확인한 뒤 새로고침하세요.
              </div>
            </div>
          </section>
        </div>
      </AppShell>
    );
  }

  const team = score.data;
  const warnings = teamWarnings(team, people);

  return (
    <AppShell
      title="기여도"
      meta={`${team.algo_version} · ${fmtComputedAt(team.computed_at)}`}
    >
      <div className="panes">
        <section className="pane">
          {warnings.length > 0 && (
            <div className="warnband" role="note">
              {warnings.map((w) => (
                <p key={w}>
                  <strong>⚠</strong> {w}
                </p>
              ))}
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
                const points = span?.points ?? 0;
                const name = nameOf(member.user_id, people);
                const detail = [...readBeforeTheNumber(member), ...integrityNotes(member)];
                const zeroCats = categoriesForDisplay(member)
                  .filter((c) => c.event_count === 0)
                  .map((c) => describeCategory(c.category));
                const gapCats = (member.measurement_gaps ?? [])
                  .map((g) => (g.category ? describeCategory(g.category) : '일부 활동'));
                return (
                  <article className="crow" key={member.user_id}>
                    <div className="crow__top">
                      <span className="crow__name">{name}</span>
                      <span className="crow__range">{describeRange(member)}</span>
                      <TrackRibbon
                        size="sm"
                        segments={ribbonFor(member, points)}
                        label={`${name} — 확신도 ${Math.round(member.confidence * 100)}% · 모르는 폭 ${Math.round(points)}%p`}
                      />
                      <span className="crow__counts">{countsLine(member)}</span>
                    </div>
                    <div className="crow__sub">
                      <span>{roleOf(member, people)}</span>
                      <div>
                        <span className="num">
                          신뢰도 {member.confidence_label} · 모르는 폭 {Math.round(points)}%p
                        </span>
                        {gapCats.length > 0 && (
                          <span className="crow__flags"> · ⚠ {gapCats.join('·')} 기여 측정 못 함</span>
                        )}
                        {hasNoEvidence(member) && (
                          <span className="crow__flags"> · ⚠ 근거가 하나도 없는 숫자입니다</span>
                        )}
                        <Disclosure summary="신뢰도 사유">
                          {detail.map((line) => (
                            <p key={line}>{line.replace(/\*\*/g, '')}</p>
                          ))}
                          {zeroCats.length > 0 && (
                            <p>
                              {zeroCats.join(', ')} 활동은 기록이 0건입니다 — 안 한 것인지
                              측정이 안 닿은 것인지는 팀이 압니다.
                            </p>
                          )}
                        </Disclosure>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="confirmbar">
            <p className="confirmbar__notice">
              {team.notice}
              {finals.data && finals.data.finals.length > 0 && (
                <> — {describeFinals(finals.data.finals, new Map(people.map((p) => [p.user_id, p.name])))}</>
              )}
            </p>
            <div className="confirmbar__row">
              {members.map((member) => {
                const name = nameOf(member.user_id, people);
                return (
                  <label className="confirmbar__person" key={member.user_id}>
                    <span className="t13">{name}</span>
                    <span className="confirmbar__sys">시스템 {member.share.toFixed(1)}</span>
                    <input
                      className="input input--num"
                      inputMode="decimal"
                      placeholder={member.share.toFixed(1)}
                      aria-label={`${name} 확정값 (%)`}
                      value={values[member.user_id] ?? ''}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [member.user_id]: e.target.value }))
                      }
                    />
                  </label>
                );
              })}
              <span className="appbar__spacer" />
              <button
                type="button"
                className="btn btn--primary"
                disabled={problems.length > 0 || blind || confirm.isPending || members.length === 0}
                onClick={() => confirm.mutate(toPayload(drafts, systemValues))}
              >
                이 값으로 확정
              </button>
            </div>
            {changed.length > 0 && (
              <div className="confirmbar__reasons">
                {changed.map((d) => {
                  const name = nameOf(d.user_id, people);
                  return (
                    <label className="confirmbar__reason" key={d.user_id}>
                      <span className="t12 muted">{name} 조정 사유</span>
                      <input
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
            {problems.length > 0 && (
              <p className="disabled-reason">
                {problems.join(' · ')} — 사유 없는 조정은 근거 없는 점수와 같습니다
              </p>
            )}
            {blind && <p className="disabled-reason">{BLIND_CONFIRM}</p>}
            {sumOff && (
              <p className="disabled-reason">
                합계가 <span className="num">{effectiveSum.toFixed(1)}</span> 입니다 — 100이
                아니어도 확정할 수 있지만, 의도한 것인지 확인하세요.
              </p>
            )}
            {confirm.isSuccess && (
              <p className="confirmbar__notice" role="status">
                확정했습니다. 시스템 값과 확정값이 함께 기록에 남습니다.
              </p>
            )}
            {confirm.isError && (
              <p className="disabled-reason" role="alert">
                확정하지 못했습니다 — {confirm.error instanceof Error ? confirm.error.message : '알 수 없는 오류'}
              </p>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
