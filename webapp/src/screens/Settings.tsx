import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import {
  useGithubHealth,
  useMe,
  useMembers,
  useProject,
  useSettingsMutations,
} from '../api/hooks.ts';
import type { Member } from '../api/types.ts';
import { ROLE_OPTIONS, problemWith, roleSummary, sumOf, toPayload } from '@lib/contribution/roles.ts';
import { describeRoles } from '@lib/contribution/roles.ts';
import { describeHealth, describeHealthFailure } from '@lib/github/health.ts';
import { githubLoginStatus, repoProblem, titleProblem, normalizeRepo } from '@lib/project/setup.ts';
import { LEAVE_CONFIRM } from '@lib/project/roles.ts';
import { presenceLabel, worthShowing } from '@lib/project/presence.ts';
import { AVATAR_SIDE, MAX_BIO, PHOTO_NOTE, bioProblem, coverCrop, photoProblem } from '@lib/profile/edit.ts';
import { ApiError } from '../api/client.ts';

// 프로젝트 설정 — **상단 탭** + 아래 판 (지시서 03, v2 F11 로 갱신).
//
// ⚠️ 원래는 좌 서브내비 200px 이었습니다. 앱 레일 72px 옆에 세로 기둥을
// 하나 더 세우는 꼴이라 내용 영역이 272px 깎였고, 설정은 화면 하나인데
// 그럴 이유가 없었습니다.
//
// 성격이 다른 것을 같은 줄에 세우지 않습니다: 내 설정 / 프로젝트 / 위험 구역.
// "회의 열기" 는 설정이 아니라 행동이라 헤더로 올라갔습니다.

const SECTIONS = [
  { group: '내 설정', key: 'role', label: '역할과 가중치' },
  { group: '내 설정', key: 'github', label: 'GitHub 계정' },
  { group: '내 설정', key: 'profile', label: '내 정보' },
  { group: '프로젝트', key: 'members', label: '팀원' },
  { group: '프로젝트', key: 'repo', label: '저장소 연결' },
  { group: '프로젝트', key: 'general', label: '이름과 초대' },
] as const;

const WHY_ONLY_ME =
  '남이 내 역할을 바꿀 수 있으면 그건 남의 점수를 바꾸는 일입니다. 역할 비중은 기여도 가중치라서, 본인만 고치고 고친 기록이 남습니다.';

function mutationError(e: unknown): string {
  if (e instanceof ApiError) return e.detail;
  if (e instanceof Error) return e.message;
  return '요청이 실패했습니다';
}

// ── 내 설정 > 역할과 가중치 ─────────────────────────────────────
function RoleSection({ mine, save }: { mine: Member | undefined; save: ReturnType<typeof useSettingsMutations>['saveRole'] }) {
  const [edited, setEdited] = useState<Record<string, string> | null>(null);
  const current: Record<string, string> =
    edited ??
    Object.fromEntries(
      ROLE_OPTIONS.map((o) => [o.key, String(mine?.role_shares[o.key] ?? 0)]),
    );
  const shares = Object.fromEntries(
    Object.entries(current).map(([k, v]) => [k, v.trim() === '' ? 0 : Number(v)]),
  );
  const problem = problemWith(shares);
  const sum = sumOf(shares);

  return (
    <div className="sec">
      <h2 className="sec__title">역할과 가중치</h2>
      <p className="sec__lead">기여도 계산에 쓰이는 값입니다. 겸직이면 나눠 적으세요.</p>
      {ROLE_OPTIONS.map((option) => (
        <div className="rolerow" key={option.key}>
          <span>{option.label}</span>
          <input
            className="input input--num"
            inputMode="decimal"
            aria-label={`${option.label} 비중`}
            value={current[option.key] ?? '0'}
            onChange={(e) => setEdited({ ...current, [option.key]: e.target.value })}
          />
          <span className="rolerow__hint">{option.hint}</span>
        </div>
      ))}
      <div className="rolerow rolerow--sum">
        <span>합계</span>
        <span className="num">{sum}</span>
        <span className="rolerow__hint">지금 {roleSummary(mine?.role_shares) ?? '미정'}</span>
      </div>
      <div className="sec__row" style={{ marginTop: 'var(--sp-5)' }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={problem !== null || save.isPending}
          onClick={() => save.mutate(toPayload(shares), { onSuccess: () => setEdited(null) })}
        >
          저장
        </button>
        {problem !== null && <span className="disabled-reason" style={{ margin: 0 }}>{problem}</span>}
        {save.isSuccess && edited === null && <span className="status-ok" role="status">저장됐습니다</span>}
        {save.isError && <span className="disabled-reason" style={{ margin: 0 }}>{mutationError(save.error)}</span>}
      </div>
      <Disclosure summary="왜 나만 바꿀 수 있나요">
        <p>{WHY_ONLY_ME}</p>
      </Disclosure>
    </div>
  );
}

// ── 내 설정 > GitHub 계정 ───────────────────────────────────────
function GithubSection({ mine, save }: { mine: Member | undefined; save: ReturnType<typeof useSettingsMutations>['saveGithubLogin'] }) {
  const [value, setValue] = useState<string | null>(null);
  const login = value ?? mine?.github_login ?? '';
  return (
    <div className="sec">
      <h2 className="sec__title">GitHub 계정</h2>
      <p className="sec__lead">이 아이디로 올린 PR·리뷰가 내 기여도로 들어옵니다.</p>
      <div className="sec__row">
        <input
          className="input input--num"
          placeholder="github-id"
          aria-label="GitHub 아이디"
          value={login}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={save.isPending || value === null}
          onClick={() => save.mutate(login.trim(), { onSuccess: () => setValue(null) })}
        >
          저장
        </button>
      </div>
      <p className={mine?.github_login ? 'status-ok' : 'micro muted'} style={{ marginTop: 'var(--sp-3)' }}>
        {githubLoginStatus(mine?.github_login ?? null)}
      </p>
      {save.isError && <p className="disabled-reason">{mutationError(save.error)}</p>}
      <Disclosure summary="왜 나만 바꿀 수 있나요">
        <p>{WHY_ONLY_ME} GitHub 아이디도 같은 이유로 본인만 바꿉니다 — 남의 아이디를 적으면 남의 활동이 내 기여도로 들어옵니다.</p>
      </Disclosure>
    </div>
  );
}

// ── 내 설정 > 내 정보 (홈에서 옮겨 옴 — 홈에 프로필 편집기가 있을 이유가 없음) ──
function ProfileSection({ save }: { save: ReturnType<typeof useSettingsMutations>['saveProfile'] }) {
  const { data: me } = useMe();
  const [bio, setBio] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const bioValue = bio ?? me?.bio ?? '';
  const avatarValue = avatar ?? me?.avatar ?? null;
  const problem = bioProblem(bioValue);
  const dirty = bio !== null || avatar !== null;

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const bad = photoProblem(file);
    if (bad !== null) {
      setPhotoError(bad);
      return;
    }
    setPhotoError(null);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIDE;
      canvas.height = AVATAR_SIDE;
      const { sx, sy, size } = coverCrop(img.width, img.height);
      canvas.getContext('2d')?.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
      setAvatar(canvas.toDataURL('image/png'));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };

  return (
    <div className="sec">
      <h2 className="sec__title">내 정보</h2>
      <p className="sec__lead">팀원 목록과 발화 옆에 함께 보입니다.</p>
      <div className="sec__row" style={{ alignItems: 'flex-start' }}>
        {avatarValue !== null ? (
          <img className="member-row__avatar" style={{ width: 96, height: 96, flexBasis: 96 }} src={avatarValue} alt="내 프로필 사진" />
        ) : (
          <div className="member-row__avatar" style={{ width: 96, height: 96, flexBasis: 96 }} aria-label="사진 없음" />
        )}
        <div style={{ flex: 1 }}>
          <label className="field">
            <span className="field__label">사진 — {PHOTO_NOTE}</span>
            <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          {photoError !== null && <p className="disabled-reason">{photoError}</p>}
        </div>
      </div>
      <label className="field" style={{ marginTop: 'var(--sp-5)' }}>
        <span className="field__label">
          자기소개 <span className="num">{bioValue.length}/{MAX_BIO}</span>
        </span>
        <textarea
          className="textarea"
          rows={3}
          value={bioValue}
          onChange={(e) => setBio(e.target.value)}
        />
      </label>
      <div className="sec__row">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || problem !== null || save.isPending}
          onClick={() => {
            const payload: { bio?: string; avatar?: string } = {};
            if (bio !== null) payload.bio = bio;
            if (avatar !== null) payload.avatar = avatar;
            save.mutate(payload, {
              onSuccess: () => {
                setBio(null);
                setAvatar(null);
              },
            });
          }}
        >
          저장
        </button>
        {problem !== null && <span className="disabled-reason" style={{ margin: 0 }}>{problem}</span>}
        {save.isSuccess && !dirty && <span className="status-ok" role="status">저장됐습니다</span>}
      </div>
    </div>
  );
}

// ── 프로젝트 > 팀원 ─────────────────────────────────────────────
function MembersSection({ members, leave }: { members: Member[]; leave: ReturnType<typeof useSettingsMutations>['leave'] }) {
  const navigate = useNavigate();
  // ⭐ 이름순 고정 — 점수 관련 정보는 여기 없습니다.
  const ordered = [...members].sort(
    (a, b) => a.name.localeCompare(b.name, 'ko') || a.user_id - b.user_id,
  );
  return (
    <div className="sec">
      <h2 className="sec__title">팀원 {members.length}명</h2>
      {ordered.map((member) => (
        <div className="member-row" key={member.user_id}>
          {member.avatar !== null ? (
            <img className="member-row__avatar" src={member.avatar} alt="" />
          ) : (
            <span className="member-row__avatar" aria-hidden="true" />
          )}
          <div>
            <div className="member-row__name">{member.name}</div>
            <div className="member-row__roles">{describeRoles(member.role_shares)}</div>
            {member.bio !== null && member.bio !== '' && <div className="t12 muted">{member.bio}</div>}
          </div>
          {worthShowing(member.presence) && (
            <span className="presence">● {presenceLabel(member.presence)}</span>
          )}
        </div>
      ))}
      <div style={{ marginTop: 'var(--sp-6)' }}>
        <button
          type="button"
          className="btn btn--secondary"
          disabled={leave.isPending}
          onClick={() => {
            if (window.confirm(LEAVE_CONFIRM)) {
              leave.mutate(undefined, { onSuccess: () => navigate('/') });
            }
          }}
        >
          이 프로젝트에서 나가기
        </button>
        {leave.isError && <p className="disabled-reason">{mutationError(leave.error)}</p>}
      </div>
    </div>
  );
}

// ── 프로젝트 > 저장소 연결 ──────────────────────────────────────
function RepoSection({
  projectId,
  repo,
  save,
  backfill,
}: {
  projectId: number;
  repo: string | null;
  save: ReturnType<typeof useSettingsMutations>['saveProject'];
  backfill: ReturnType<typeof useSettingsMutations>['backfill'];
}) {
  const health = useGithubHealth(projectId);
  const [value, setValue] = useState<string | null>(null);
  const input = value ?? repo ?? '';
  const problem = input.trim() === '' ? null : repoProblem(input);
  // 아직 연결할 수 없는 경우 — 안 고쳤거나(`value === null`), 주소가 틀렸거나.
  const connectBlocked = value === null || problem !== null;
  const view = health.data
    ? describeHealth(health.data, new Date())
    : health.isError
      ? describeHealthFailure(health.error instanceof ApiError ? health.error.status : 0)
      : null;

  return (
    <div className="sec">
      <h2 className="sec__title">저장소 연결</h2>
      <p className="sec__lead">이 저장소의 PR·리뷰가 팀의 기여 기록으로 들어옵니다.</p>
      <div className="sec__row">
        <input
          id="repo-input"
          className="input input--num"
          placeholder="owner/repo"
          aria-label="GitHub 저장소"
          value={input}
          onChange={(e) => setValue(e.target.value)}
        />
        {/* ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다 — 비활성 버튼은
            초점을 못 받아 낭독기에 사유를 못 전합니다(GOV.UK). 사유(`problem`)
            는 바로 아래 적혀 있는데, 그 자리로 닿는 길이 없었습니다.
            누르면 저장소 칸으로 데려다 줍니다. */}
        <button
          type="button"
          className={`btn btn--primary${connectBlocked ? ' btn--unmet' : ''}`}
          aria-disabled={connectBlocked || save.isPending}
          aria-describedby={problem !== null ? 'repo-problem' : undefined}
          onClick={() => {
            if (save.isPending) return;
            if (connectBlocked) {
              document.getElementById('repo-input')?.focus();
              return;
            }
            save.mutate({ github_repo: normalizeRepo(input) }, { onSuccess: () => setValue(null) });
          }}
        >
          연결
        </button>
      </div>
      {problem !== null && <p className="disabled-reason" id="repo-problem">{problem}</p>}
      {save.isError && <p className="disabled-reason">{mutationError(save.error)}</p>}
      {view !== null && (
        <div className={view.tone === 'ok' ? 'card' : 'notice'} style={{ marginTop: 'var(--sp-5)' }} role="note">
          <p>
            <strong>{view.headline}</strong>
          </p>
          <p className="t13">{view.detail}</p>
          {view.nextStep !== null && <p className="t13">{view.nextStep}</p>}
          {view.warnings.map((w) => (
            <p className="t12 muted" key={w}>
              {w}
            </p>
          ))}
          {view.activity !== '' && <p className="t12 num">{view.activity}</p>}
          {view.coverage !== '' && <p className="t12 muted">{view.coverage}</p>}
          {view.canBackfill && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              style={{ marginTop: 'var(--sp-3)' }}
              disabled={backfill.isPending || backfill.isSuccess}
              onClick={() => backfill.mutate()}
            >
              {backfill.isSuccess ? '가져오는 중 — 잠시 뒤 새로 고쳐 보세요' : '지난 활동 가져오기'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── 프로젝트 > 이름과 초대 ──────────────────────────────────────
function GeneralSection({
  title,
  inviteCode,
  save,
  rotate,
}: {
  title: string;
  inviteCode: string;
  save: ReturnType<typeof useSettingsMutations>['saveProject'];
  rotate: ReturnType<typeof useSettingsMutations>['rotateInvite'];
}) {
  const [value, setValue] = useState<string | null>(null);
  const input = value ?? title;
  const problem = titleProblem(input);
  return (
    <div className="sec">
      <h2 className="sec__title">이름과 초대</h2>
      <label className="field">
        <span className="field__label">프로젝트 이름</span>
        <div className="sec__row">
          <input className="input" value={input} onChange={(e) => setValue(e.target.value)} />
          <button
            type="button"
            className="btn btn--primary"
            disabled={value === null || problem !== null || save.isPending}
            onClick={() => save.mutate({ title: input.trim() }, { onSuccess: () => setValue(null) })}
          >
            저장
          </button>
        </div>
      </label>
      {problem !== null && value !== null && <p className="disabled-reason">{problem}</p>}
      <h3 className="pane__title" style={{ margin: 'var(--sp-6) 0 var(--sp-3)' }}>
        팀원 초대
      </h3>
      <div>
        <span className="invite-code">{inviteCode === '' ? '(없음)' : inviteCode}</span>
      </div>
      <div className="sec__row">
        <button type="button" className="btn btn--secondary" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
          코드 새로 만들기
        </button>
      </div>
      <Disclosure summary="코드를 새로 만들면 어떻게 되나요">
        <p>이전 코드는 그 즉시 무효가 됩니다. 이미 들어온 팀원은 그대로 남습니다.</p>
      </Disclosure>
      {save.isError && <p className="disabled-reason">{mutationError(save.error)}</p>}
    </div>
  );
}

// ── 위험 구역 > 내 녹음 지우기 ──────────────────────────────────
function DangerSection({ revoke }: { revoke: ReturnType<typeof useSettingsMutations>['revokeMyData'] }) {
  return (
    <div className="sec">
      <h2 className="sec__title">내 녹음 지우기</h2>
      <p className="sec__lead">
        이 프로젝트에 남아 있는 내 목소리를 지웁니다. 개인정보 삭제
        요청권(개인정보보호법 제36조)입니다.
      </p>
      <div className="two-col">
        <div>
          <h4>지워지는 것</h4>
          <ul>
            <li>내 목소리가 녹음된 원본 파일</li>
            <li>내 성문 데이터</li>
          </ul>
        </div>
        <div>
          <h4>남는 것</h4>
          <ul>
            <li>회의록의 발화 텍스트</li>
            <li>칸반 업무와 GitHub 활동</li>
          </ul>
        </div>
      </div>
      <Disclosure summary="기여도는 어떻게 되나요">
        <p>
          회의 발화 텍스트와 업무·코드 활동은 남으므로 기여도 계산은 그대로
          이어집니다. 다만 지운 뒤의 회의는 내 트랙이 없어 회의 기여를 재지
          못할 수 있고, 그 구간은 0이 아니라 “측정하지 못했다”로 남습니다.
        </p>
      </Disclosure>
      <div style={{ marginTop: 'var(--sp-6)' }}>
        <button
          type="button"
          className="btn btn--danger"
          disabled={revoke.isPending}
          onClick={() => {
            if (
              window.confirm(
                '내 녹음 원본과 성문 데이터를 지웁니다. 되돌릴 수 없습니다. 계속할까요?',
              )
            ) {
              revoke.mutate();
            }
          }}
        >
          내 녹음과 성문 지우기
        </button>
      </div>
      {revoke.isSuccess && (
        <div className="notice" style={{ marginTop: 'var(--sp-5)' }} role="status">
          <p>
            원본 <span className="num">{revoke.data.deleted_assets}</span>건 · 성문{' '}
            <span className="num">{revoke.data.revoked_voiceprints}</span>건을 지웠습니다.
          </p>
          {revoke.data.kept.map((k) => (
            <p className="t12" key={k}>
              {k}
            </p>
          ))}
          {Object.keys(revoke.data.failed).length > 0 && (
            <p className="t12">
              지우지 못한 것이 {Object.keys(revoke.data.failed).length}건 있습니다 — 다시
              요청해 주세요.
            </p>
          )}
        </div>
      )}
      {revoke.isError && <p className="disabled-reason">{mutationError(revoke.error)}</p>}
    </div>
  );
}

export default function Settings() {
  const params = useParams();
  const navigate = useNavigate();
  const projectId = Number(params['projectId']);
  const section = params['section'] ?? 'role';
  const project = useProject(projectId);
  const membersQuery = useMembers(projectId);
  const { data: me } = useMe();
  const m = useSettingsMutations(projectId);

  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const mine = members.find((member) => member.user_id === me?.user_id);

  const groups = [...new Set(SECTIONS.map((s) => s.group))];

  return (
    <AppShell
      title={project.data?.title ?? '설정'}
      actions={
        /* ⚠️ 여기서는 **secondary** 입니다 (v2 F9). 설정 화면에 온 사람이
           하려는 일은 `저장`·`연결` 이고, 전역 단축 버튼이 그보다 크게
           보이면 눈이 먼저 엉뚱한 데로 갑니다. 홈에서는 이 버튼이
           primary 입니다 — 거기서는 그게 하려는 일이니까요. */
        <button
          type="button"
          className="btn btn--secondary"
          disabled={m.openMeeting.isPending}
          onClick={() =>
            m.openMeeting.mutate(undefined, {
              onSuccess: (meeting) => navigate(`/meeting/${meeting.meeting_id}/lobby`),
            })
          }
        >
          회의 열기
        </button>
      }
    >
      <div className="tabbed">
        {/* ⚠️ **내비가 두 겹이었습니다** (v2 F11) — 앱 레일 72px + 설정
            사이드바 200px. 설정은 화면 하나인데 세로 기둥 둘을 세우고
            내용 영역을 272px 깎아 먹었습니다. 상단 탭으로 내리면 그 200px
            이 내용으로 돌아옵니다.

            묶음 이름(`내 설정`·`프로젝트`)은 **탭 사이 구분선**이 됩니다 —
            탭 줄에 머리말을 넣으면 누를 수 없는 글자가 탭처럼 보입니다.
            대신 `title` 로 남겨 낭독기와 마우스에는 전해집니다. */}
        <nav className="tabs" aria-label="설정 구역">
          {groups.map((group, gi) => (
            <span className="tabs__group" key={group}>
              {gi > 0 && <span className="tabs__sep" aria-hidden="true" />}
              {SECTIONS.filter((s) => s.group === group).map((s) => (
                <NavLink
                  key={s.key}
                  to={`/project/${projectId}/settings/${s.key}`}
                  className="tabs__item"
                  title={`${group} · ${s.label}`}
                  aria-current={section === s.key ? 'page' : undefined}
                >
                  {s.label}
                </NavLink>
              ))}
            </span>
          ))}
          {/* 위험 구역은 **오른쪽 끝**에 따로 떨어뜨립니다 — 손이 미끄러져
              눌리는 자리에 두면 안 됩니다. */}
          <NavLink
            to={`/project/${projectId}/settings/danger`}
            className="tabs__item tabs__item--danger"
            aria-current={section === 'danger' ? 'page' : undefined}
          >
            내 녹음 지우기
          </NavLink>
        </nav>
        <section className="pane">
          <div className="pane__body">
            {section === 'role' && <RoleSection mine={mine} save={m.saveRole} />}
            {section === 'github' && <GithubSection mine={mine} save={m.saveGithubLogin} />}
            {section === 'profile' && <ProfileSection save={m.saveProfile} />}
            {section === 'members' && <MembersSection members={members} leave={m.leave} />}
            {section === 'repo' && (
              <RepoSection
                projectId={projectId}
                repo={project.data?.github_repo ?? null}
                save={m.saveProject}
                backfill={m.backfill}
              />
            )}
            {section === 'general' && project.data && (
              <GeneralSection
                title={project.data.title}
                inviteCode={project.data.invite_code}
                save={m.saveProject}
                rotate={m.rotateInvite}
              />
            )}
            {section === 'danger' && <DangerSection revoke={m.revokeMyData} />}
            {m.openMeeting.isError && (
              <p className="disabled-reason">{mutationError(m.openMeeting.error)}</p>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
