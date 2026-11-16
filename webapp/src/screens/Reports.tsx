import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Problem } from '../components/Problem.tsx';
import { ApiError } from '../api/client.ts';
import {
  useGenerateReport,
  useMeetings,
  useReportDetail,
  useReports,
} from '../api/hooks.ts';
import {
  describeConfidence,
  describeFinal,
  describeRange,
  describeReportType,
  describeWhen,
  emptyReports,
  gapsOf,
  personGapsHeading,
  subjectOf,
  teamReasonsHeading,
  tooNewToRender,
  toPlainText,
  type Block,
  type Person,
  type ReportContent,
} from '@lib/reports/view.ts';
import { copySucceeded, copyText, describeCopy } from '@lib/ui/copy.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

function detailOf(error: unknown): string | null {
  return error instanceof ApiError ? error.detail : null;
}

function PersonBlockRow({ person }: { person: Person }) {
  const confidence = describeConfidence(person);
  const holes = gapsOf(person);
  const final = describeFinal(person);
  return (
    <div className="tf-rep-person">
      <div className="tf-rep-person__who">
        <strong>{person.name}</strong>
        <span className="t12 muted">{person.role}</span>
      </div>
      <div className="tf-rep-person__val">
        <p className={`num ${person.measured ? 'tf-rep-range' : 'gap'}`}>{describeRange(person)}</p>
        {confidence !== null && <p className="t12 muted">{confidence}</p>}
        {person.measured && <p className="t12 muted num">근거 {person.evidence_count}건</p>}
      </div>
      <div className="tf-rep-person__why">
        {person.reasons.length > 0 && (
          <>
            <p className="t12 faint" style={{ margin: '0 0 2px', fontWeight: 600 }}>{teamReasonsHeading()}</p>
            <ul className="tf-rep-notes">
              {person.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
        {holes.length > 0 && (
          <>
            <p className="t12 gap" style={{ margin: '6px 0 2px', fontWeight: 600 }}>{personGapsHeading()}</p>
            <ul className="tf-rep-notes tf-rep-notes--gap">
              {holes.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </>
        )}
        {final !== null && <p className="t12" style={{ margin: '6px 0 0', color: 'var(--c-evidence)', fontWeight: 600 }}>{final}</p>}
      </div>
    </div>
  );
}

function ReportBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return <h2 className="tf-rep-h2">{block.text}</h2>;
    case 'paragraph':
      return <p className="t13" style={{ lineHeight: 1.6 }}>{block.text}</p>;
    case 'facts':
      return (
        <dl className="tf-rep-facts">
          {block.items.map((item) => (
            <div className="tf-rep-fact" key={item.label}>
              <dt>{item.label}</dt>
              <dd className={item.gap ? 'gap' : 'num'}>
                {item.gap ? '못 쟀습니다' : item.value}
                {item.note !== undefined && item.note !== '' && (
                  <span className="t12 muted" style={{ display: 'block', marginTop: '2px' }}>{item.note}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'list':
      return block.items.length === 0 ? (
        <p className="t13 muted">{block.empty_note}</p>
      ) : (
        <ul className="tf-rep-list">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case 'people':
      // ⚠️ 서버가 이름 순으로 내려준 순서를 그대로 사용합니다 (재정렬 금지).
      return (
        <div className="tf-rep-people">
          {block.people.map((person, index) => (
            <PersonBlockRow key={`${index}/${person.name}/${person.role}`} person={person} />
          ))}
        </div>
      );
    case 'gap':
      return <p className="t13 gap">{block.text}</p>;
  }
}

function ReportContentBody({ content }: { content: ReportContent }) {
  if (tooNewToRender(content)) {
    return (
      <p className="t13 gap">
        이 보고서는 더 새로운 형식으로 만들어졌습니다. 앱을 업데이트해 주세요 — 내용이 빈 것이 아닙니다.
      </p>
    );
  }
  return (
    <div className="tf-rep-doc">
      <h1 className="tf-rep-title">{content.title}</h1>
      {content.notices.length > 0 && (
        <div className="tf-rep-notices" role="note">
          {content.notices.map((notice) => (
            <p key={notice} style={{ margin: '0 0 4px' }}>{notice}</p>
          ))}
        </div>
      )}
      {content.blocks.map((block, idx) => (
        <ReportBlock key={idx} block={block} />
      ))}
    </div>
  );
}

export default function Reports() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = Number(params['projectId']);
  const pid = Number.isFinite(projectId) ? projectId : undefined;

  const reports = useReports(pid);
  const meetings = useMeetings(pid);
  const generate = useGenerateReport(pid);

  const requestedId = Number(searchParams.get('report'));
  const rows = reports.data ?? [];
  const selectedId =
    Number.isFinite(requestedId) && rows.some((r) => r.id === requestedId)
      ? requestedId
      : rows[0]?.id ?? null;

  const detail = useReportDetail(selectedId);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    setCopyNote(null);
  }, [selectedId]);

  const listError =
    reports.error == null ? null : describeLoadFailure('보고서 목록', statusOf(reports.error));
  const detailError =
    detail.error == null ? null : describeLoadFailure('보고서 본문', statusOf(detail.error));

  const meetingCount = meetings.isSuccess ? meetings.data.length : null;
  const empty = emptyReports(meetingCount);

  const selectReport = (id: number) => {
    setSearchParams({ report: String(id) });
  };

  const make = (kind: 'weekly' | 'final') => {
    setActionMsg(null);
    generate.mutate(kind, {
      onSuccess: (created) => {
        setActionMsg('보고서를 만들었습니다');
        selectReport(created.id);
      },
    });
  };

  const copyMarkdown = async () => {
    if (!detail.data?.content) return;
    const outcome = await copyText(toPlainText(detail.data.content), navigator.clipboard);
    setCopyNote(copySucceeded(outcome) ? '보고서 전문을 클립보드에 복사했습니다' : describeCopy(outcome, '보고서'));
  };

  const downloadMarkdown = () => {
    if (!detail.data?.content) return;
    const text = toPlainText(detail.data.content);
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = (detail.data.content.title || 'teamflow-report')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .slice(0, 64);
    a.href = url;
    a.download = `${safeTitle}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell
      title="보고서"
      projectId={projectId}
      meta={
        <span className="meta-chips">
          <span className="meta-chip">
            총 <strong className="num">{reports.isSuccess ? rows.length : '—'}</strong>건
          </span>
        </span>
      }
      actions={
        listError === null && reports.isSuccess ? (
          <div className="appbar__actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={generate.isPending}
              onClick={() => make('weekly')}
            >
              이번 주 보고서 만들기
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={generate.isPending}
              onClick={() => make('final')}
            >
              최종 보고서 만들기
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="panes tf-reports-panes">
        <section className="pane tf-reports-list-pane" aria-label="보고서 목록">
          <div className="pane__head">
            <h2 className="pane__title">만든 보고서</h2>
            <span className="pane__count">{reports.isSuccess ? rows.length : '—'}</span>
          </div>
          <div className="pane__body">
            {actionMsg !== null && (
              <p className="status-ok" role="status" style={{ marginBottom: 'var(--sp-3)' }}>
                {actionMsg}
              </p>
            )}
            {generate.isError && (
              <Problem>
                {describeActionFailure(
                  '보고서 만들기',
                  statusOf(generate.error),
                  detailOf(generate.error),
                )}
              </Problem>
            )}
            {listError !== null ? (
              <Problem>{listError}</Problem>
            ) : reports.isPending ? (
              <p className="t13 muted">보고서 목록을 불러오는 중입니다…</p>
            ) : rows.length === 0 ? (
              <div className="empty">
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{empty.what}</p>
                <p className="t12 muted" style={{ margin: '0 0 4px' }}>{empty.why}</p>
                <p className="t12 faint" style={{ margin: 0 }}>{empty.how}</p>
              </div>
            ) : (
              <div className="tf-rep-list-cards">
                {rows.map((row) => {
                  const sub = subjectOf(row);
                  const isActive = row.id === selectedId;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={`tf-rep-list-item${isActive ? ' is-active' : ''}`}
                      onClick={() => selectReport(row.id)}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        <span className="tf-notice-kind">{describeReportType(row.report_type)}</span>
                        <span className="t12 faint num">{describeWhen(row)}</span>
                      </div>
                      {sub !== '' && <div className="tf-rep-list-item__title">{sub}</div>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="pane tf-reports-detail-pane" aria-label="보고서 본문">
          <div className="pane__head tf-no-print">
            <h2 className="pane__title">미리보기 & 내보내기</h2>
            {detail.data && (
              <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' }}>
                {detail.data.meeting_id !== null && (
                  <>
                    <Link
                      to={`/meeting/${detail.data.meeting_id}/review`}
                      className="btn btn--ghost btn--sm"
                    >
                      원본 회의 검토 보기 →
                    </Link>
                    <Link
                      to={`/meeting/${detail.data.meeting_id}/lobby`}
                      className="btn btn--ghost btn--sm"
                    >
                      회의 로비 →
                    </Link>
                  </>
                )}
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => void copyMarkdown()}>
                  텍스트 복사
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={downloadMarkdown}>
                  .md 다운로드
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => window.print()}>
                  인쇄 / PDF 저장
                </button>
              </div>
            )}
          </div>
          <div className="pane__body">
            {copyNote !== null && (
              <p className="status-ok tf-no-print" role="status" style={{ marginBottom: 'var(--sp-3)' }}>
                {copyNote}
              </p>
            )}
            {listError !== null ? (
              <p className="t13 muted">보고서 목록을 불러오지 못해 미리보기를 열 수 없습니다.</p>
            ) : reports.isPending ? (
              <p className="t13 muted">보고서 목록을 확인하는 중입니다…</p>
            ) : selectedId === null ? (
              <div className="empty">왼쪽 목록에서 보고서를 고르거나 상단에서 새 보고서를 만드세요.</div>
            ) : detailError !== null ? (
              <Problem>{detailError}</Problem>
            ) : detail.isPending ? (
              <p className="t13 muted">보고서를 불러오는 중입니다…</p>
            ) : detail.data ? (
              <ReportContentBody content={detail.data.content} />
            ) : null}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
