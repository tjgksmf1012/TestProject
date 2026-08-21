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
import { plainText } from '@lib/ui/plain.ts';
import { describeHealth, describeHealthFailure } from '@lib/github/health.ts';
import {
  disconnectConfirm,
  githubLoginStatus,
  isDisconnect,
  normalizeRepo,
  repoProblem,
  titleProblem,
} from '@lib/project/setup.ts';
import {
  LEAVE_CONFIRM,
  assignableRoles,
  canChangeRoleOf,
  canRemove,
  leaveBlockedBecause,
  manageBlockedBecause,
  roleLabel,
} from '@lib/project/roles.ts';
import { presenceLabel, worthShowing } from '@lib/project/presence.ts';
import { describeOutcome } from '@lib/privacy/deletion.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';
import { whyCannotSave } from '@lib/ui/save.ts';
import { AVATAR_SIDE, MAX_BIO, PHOTO_NOTE, bioProblem, coverCrop, photoProblem } from '@lib/profile/edit.ts';
import { ApiError } from '../api/client.ts';
import { Problem } from '../components/Problem.tsx';

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
  const roleBlocked = whyCannotSave({ problem, saving: save.isPending });
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
            id={option.key === ROLE_OPTIONS[0]?.key ? 'role-first' : undefined}
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
        {/* ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다 (결함 234).
            `disabled` 는 초점을 못 받아 **Tab 이 건너뜁니다** — 바로 옆에
            적힌 사유로 닿는 길이 없었습니다. 누르면 첫 비중 칸으로
            데려다 줍니다. */}
        <button
          type="button"
          className={`btn btn--primary${roleBlocked !== null ? ' btn--unmet' : ''}`}
          aria-disabled={roleBlocked !== null}
          aria-describedby={roleBlocked !== null ? 'role-problem' : undefined}
          onClick={() => {
            if (save.isPending) return;
            if (roleBlocked !== null) {
              document.getElementById('role-first')?.focus();
              return;
            }
            save.mutate(toPayload(shares), { onSuccess: () => setEdited(null) });
          }}
        >
          저장
        </button>
        <Problem id="role-problem" tone="incomplete" inline>{roleBlocked}</Problem>
        {save.isSuccess && edited === null && <span className="status-ok" role="status">저장됐습니다</span>}
        <Problem inline>{save.isError ? mutationError(save.error) : null}</Problem>
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
  const ghBlocked = whyCannotSave({ dirty: value !== null, saving: save.isPending });
  return (
    <div className="sec">
      <h2 className="sec__title">GitHub 계정</h2>
      <p className="sec__lead">이 아이디로 올린 PR·리뷰가 내 기여도로 들어옵니다.</p>
      <div className="sec__row">
        <input
          className="input input--num"
          id="gh-input"
          placeholder="github-id"
          aria-label="GitHub 아이디"
          value={login}
          onChange={(e) => setValue(e.target.value)}
        />
        {/* 결함 234 — `disabled` 는 초점을 못 받습니다. */}
        <button
          type="button"
          className={`btn btn--primary${ghBlocked !== null ? ' btn--unmet' : ''}`}
          aria-disabled={ghBlocked !== null}
          aria-describedby={ghBlocked !== null ? 'gh-problem' : undefined}
          onClick={() => {
            if (save.isPending) return;
            if (ghBlocked !== null) {
              document.getElementById('gh-input')?.focus();
              return;
            }
            save.mutate(login.trim(), { onSuccess: () => setValue(null) });
          }}
        >
          저장
        </button>
      </div>
      <Problem id="gh-problem" tone="incomplete">{ghBlocked}</Problem>
      <p className={mine?.github_login ? 'status-ok' : 'micro muted'} style={{ marginTop: 'var(--sp-3)' }}>
        {githubLoginStatus(mine?.github_login ?? null)}
      </p>
      <Problem>{save.isError ? mutationError(save.error) : null}</Problem>
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
  const profileBlocked = whyCannotSave({ problem, dirty, saving: save.isPending });

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
          <Problem>{photoError}</Problem>
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
        {/* 결함 234 — `disabled` 는 초점을 못 받습니다. */}
        <button
          type="button"
          className={`btn btn--primary${profileBlocked !== null ? ' btn--unmet' : ''}`}
          aria-disabled={profileBlocked !== null}
          aria-describedby={profileBlocked !== null ? 'profile-problem' : undefined}
          onClick={() => {
            if (save.isPending) return;
            if (profileBlocked !== null) return;
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
        {/* ⚠️ `aria-describedby` 가 **없는 id 를 가리키면** 낭독기에는
            아무 말도 안 됩니다 — 사유가 없는 것보다 나쁩니다. 처음에
            이 자리를 안 만들어 놓고 가리켰습니다 (결함 234). */}
        <Problem id="profile-problem" tone="incomplete" inline>{profileBlocked}</Problem>
        {save.isSuccess && !dirty && <span className="status-ok" role="status">저장됐습니다</span>}
      </div>
    </div>
  );
}

// ── 프로젝트 > 팀원 ─────────────────────────────────────────────
/**
 * 팀원 — 등급 보기 · 바꾸기 · 내보내기 (`PROJECT-003`·`PROJECT-004`).
 *
 * ## ⚠️ 판단은 처음부터 있었는데 이 화면만 안 불렀습니다
 *
 * `@lib/project/roles.ts` 에 `roleLabel`·`canChangeRoleOf`·
 * `assignableRoles`·`canRemove`·`leaveBlockedBecause` 가 전부 있고 검사도
 * 붙어 있습니다. 레거시 화면(`demo/project.tsx`)은 그걸 부르고 등급
 * `<select>` 와 내보내기 버튼을 그렸는데, **리디자인 SPA 는 이름과 기여도
 * 가중치만 그렸습니다.** 레거시가 부르고 있어서 "아무도 안 쓰는 export"
 * 가드도 조용히 통과했습니다 — 결함 197 과 똑같은 모양이고, 이번이 네
 * 번째입니다.
 *
 * 그 동안 소유자·관리자가 SPA 안에서 할 수 없던 것:
 * 누가 어떤 등급인지 보기 · 팀원을 올리고 내리기 · 팀원 내보내기.
 *
 * ⚠️ **막는 것은 지우지 않고 이유를 말합니다.** 없어진 버튼은 "이 화면은
 *    그걸 못 한다" 가 아니라 "고장 났다" 로 읽힙니다.
 */
function MembersSection({
  members,
  myUserId,
  myRole,
  leave,
  changeRole,
  removeMember,
}: {
  members: Member[];
  myUserId: number | undefined;
  /** 내 권한. **한 벌만** 만듭니다 — 두 곳에서 각자 구하면 한쪽만 고쳐집니다. */
  myRole: string | null | undefined;
  leave: ReturnType<typeof useSettingsMutations>['leave'];
  changeRole: ReturnType<typeof useSettingsMutations>['changeRole'];
  removeMember: ReturnType<typeof useSettingsMutations>['removeMember'];
}) {
  const navigate = useNavigate();
  // ⭐ 이름순 고정 — 점수 관련 정보는 여기 없습니다.
  const ordered = [...members].sort(
    (a, b) => a.name.localeCompare(b.name, 'ko') || a.user_id - b.user_id,
  );
  const canGive = assignableRoles(myRole);
  // ⚠️ 나가기가 막히는 이유는 **누르기 전에** 말합니다. 예전에는 누른 뒤
  //    서버 409 로만 나왔습니다.
  const leaveBlocked = leaveBlockedBecause(myRole, members.map((x) => x.project_role));

  return (
    <div className="sec">
      <h2 className="sec__title">팀원 {members.length}명</h2>
      {ordered.map((member) => {
        const isMe = member.user_id === myUserId;
        const mayChange = canChangeRoleOf(myRole, member.project_role, { isMe });
        const mayRemove = canRemove(myRole, member.project_role, { isMe });
        return (
          <div className="member-row" key={member.user_id}>
            {member.avatar !== null ? (
              <img className="member-row__avatar" src={member.avatar} alt="" />
            ) : (
              <span className="member-row__avatar" aria-hidden="true" />
            )}
            <div>
              <div className="member-row__name">
                {member.name}
                {/* 등급은 **글자**입니다. 색이나 길이로 줄 세우지 않습니다. */}
                <span className="member-row__rank">{roleLabel(member.project_role)}</span>
              </div>
              <div className="member-row__roles">{describeRoles(member.role_shares)}</div>
              {member.bio !== null && member.bio !== '' && <div className="t12 muted">{member.bio}</div>}
            </div>
            {worthShowing(member.presence) && (
              <span className="presence">● {presenceLabel(member.presence)}</span>
            )}
            {mayChange && canGive.length > 0 && (
              <label className="member-row__act">
                <span className="vh">{member.name} 등급</span>
                <select
                  className="input input--sm"
                  value={member.project_role}
                  disabled={changeRole.isPending}
                  onChange={(e) =>
                    changeRole.mutate({ userId: member.user_id, role: e.target.value })
                  }
                >
                  {/* 지금 등급이 내가 줄 수 있는 목록 밖일 수 있습니다
                      (소유자를 관리자가 볼 때) — 그때도 값이 비지 않게 둡니다. */}
                  {!canGive.includes(member.project_role as (typeof canGive)[number]) && (
                    <option value={member.project_role}>{roleLabel(member.project_role)}</option>
                  )}
                  {canGive.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {mayRemove && (
              /* ⛔ **화면에서 제일 약한 것이 제일 위험한 행동이었습니다**
                 (결함 257). 재 보니 `--text-muted`(본문 글자와 같은 색)에
                 테두리도 배경도 없었고, 같은 화면의 「내 녹음 지우기」만
                 빨강이었습니다. 색은 위험, 무게는 조용으로 갑니다. */
              <button
                type="button"
                className="btn btn--danger-quiet btn--sm"
                disabled={removeMember.isPending}
                onClick={() => {
                  if (window.confirm(`${member.name} 님을 이 프로젝트에서 내보냅니다. 그 사람이 한 일(업무·발화·기여 기록)은 그대로 남습니다.`)) {
                    removeMember.mutate(member.user_id);
                  }
                }}
              >
                내보내기
              </button>
            )}
          </div>
        );
      })}
      <Problem>
        {changeRole.isError
          ? mutationError(changeRole.error)
          : removeMember.isError
            ? mutationError(removeMember.error)
            : null}
      </Problem>
      <div style={{ marginTop: 'var(--sp-6)' }}>
        <button
          type="button"
          className={`btn btn--secondary${leaveBlocked !== null ? ' btn--unmet' : ''}`}
          aria-disabled={leaveBlocked !== null}
          aria-describedby={leaveBlocked !== null ? 'leave-why' : undefined}
          onClick={() => {
            if (leaveBlocked !== null) return;
            if (leave.isPending) return;
            if (window.confirm(LEAVE_CONFIRM)) {
              leave.mutate(undefined, { onSuccess: () => navigate('/') });
            }
          }}
        >
          이 프로젝트에서 나가기
        </button>
        <Problem id="leave-why" tone="incomplete">
          {leaveBlocked}
        </Problem>
        <Problem>{leave.isError ? mutationError(leave.error) : null}</Problem>
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
  myRole,
}: {
  projectId: number;
  repo: string | null;
  /** 내 권한 — 저장소 연결은 관리자만 (결함 225). */
  myRole: string | null | undefined;
  save: ReturnType<typeof useSettingsMutations>['saveProject'];
  backfill: ReturnType<typeof useSettingsMutations>['backfill'];
}) {
  const health = useGithubHealth(projectId);
  const [value, setValue] = useState<string | null>(null);
  const input = value ?? repo ?? '';
  const problem = input.trim() === '' ? null : repoProblem(input);
  // 낱말이 **하는 일과 같아야** 합니다 (결함 256).
  const disconnecting = isDisconnect(repo, input);
  // 아직 연결할 수 없는 경우 — 안 고쳤거나(`value === null`), 주소가 틀렸거나.
  /* ⚠️ 관리자만 되는 일입니다 (결함 225) — 구성원에게도 눌렸고, 서버는
     403 을 주는데 화면은 아무 말도 안 했습니다. */
  const manageBlocked = manageBlockedBecause(myRole, '저장소 연결');
  /* ⛔ **안 건드린 첫 화면에서 「연결」이 막혔는데 이유가 없었습니다**
     (결함 235). `aria-disabled` 라 초점은 받는데, `manageBlocked` 도
     `problem` 도 `null` 이면 `aria-describedby` 가 안 붙어 **아무 말도
     안 했습니다.** 234 를 고치면서 이 패널만 빼놨습니다 — 하필 그
     넷의 **모범**이던 자리입니다. */
  const connectBlocked = whyCannotSave({
    noPermission: manageBlocked,
    problem,
    dirty: value !== null,
    saving: save.isPending,
  });
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
        {/* ⚠️ 오류가 **바로 아래 적혀 있는데 칸과 이어져 있지 않았습니다.**
            낭독기는 칸에 초점이 갔을 때 `aria-describedby` 가 가리키는 것만
            읽습니다 — 이어 놓지 않으면 화면에만 뜨고 아무도 안 듣습니다. */}
        <input
          id="repo-input"
          className="input input--num"
          placeholder="owner/repo"
          aria-label="GitHub 저장소"
          aria-invalid={problem !== null}
          aria-describedby="repo-problem"
          value={input}
          onChange={(e) => setValue(e.target.value)}
        />
        {/* ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다 — 비활성 버튼은
            초점을 못 받아 낭독기에 사유를 못 전합니다(GOV.UK). 사유(`problem`)
            는 바로 아래 적혀 있는데, 그 자리로 닿는 길이 없었습니다.
            누르면 저장소 칸으로 데려다 줍니다. */}
        {/* ⛔ **칸을 비우고 누르면 연결이 끊겼습니다** — 확인도, 알림도,
            되돌릴 실마리도 없이 (결함 256). 게다가 버튼에는 「연결」이라고
            적혀 있었습니다. 낱말이 하는 일과 달랐던 것입니다.
            판단(`isDisconnect`·`disconnectConfirm`)은 `@lib`. */}
        <button
          type="button"
          className={`btn btn--primary${connectBlocked !== null ? ' btn--unmet' : ''}`}
          aria-disabled={connectBlocked !== null}
          aria-describedby={connectBlocked !== null ? 'repo-blocked' : undefined}
          onClick={() => {
            if (save.isPending || manageBlocked !== null) return;
            if (connectBlocked !== null) {
              document.getElementById('repo-input')?.focus();
              return;
            }
            if (disconnecting && !window.confirm(disconnectConfirm(repo ?? ''))) return;
            save.mutate({ github_repo: normalizeRepo(input) }, { onSuccess: () => setValue(null) });
          }}
        >
          {disconnecting ? '연결 해제' : '연결'}
        </button>
      </div>
      {/* 칸 옆 오류는 **그 칸과** 이어져 있어야 합니다 — 입력칸이
          `aria-describedby="repo-problem"` 으로 이 자리를 가리킵니다. */}
      <Problem id="repo-problem" tone="incomplete">{problem}</Problem>
      <Problem id="repo-blocked" tone="incomplete">{connectBlocked}</Problem>
      <Problem>{save.isError ? mutationError(save.error) : null}</Problem>
      {view !== null && (
        <div className={view.tone === 'ok' ? 'card' : 'notice'} style={{ marginTop: 'var(--sp-5)' }} role="note">
          {/* ⛔ **마크다운 표시가 화면까지 나왔습니다** (결함 262).
              서버 문구에는 강조(`**…**`)와 코드 표시(백틱)가 섞여 있고,
              그건 같은 문장이 마크다운 보고서로도 나가기 때문입니다.
              걷어낼 자리는 화면이고, 그 일은 `@lib` 의 `plainText` 한
              벌이 합니다 — 예전에는 세 벌이 있었고 셋 다 백틱을 놓쳤습니다. */}
          <p>
            <strong>{plainText(view.headline)}</strong>
          </p>
          <p className="t13">{plainText(view.detail)}</p>
          {view.nextStep !== null && <p className="t13">{plainText(view.nextStep)}</p>}
          {view.warnings.map((w) => (
            <p className="t12 muted" key={w}>
              {plainText(w)}
            </p>
          ))}
          {view.activity !== '' && <p className="t12 num">{view.activity}</p>}
          {view.coverage !== '' && <p className="t12 muted">{view.coverage}</p>}
          {/* ⚠️ **실패해도 아무 말도 안 했습니다** (결함 218). 500 을 받아도
              화면이 그대로라 사람은 가져오는 중인 줄 알고 기다립니다. */}
          {backfill.isError && (
            <Problem>
              {describeActionFailure(
                '지난 활동 가져오기',
                backfill.error instanceof ApiError ? backfill.error.status : null,
              )}
            </Problem>
          )}
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
  myRole,
}: {
  title: string;
  inviteCode: string;
  /** 내 권한. **관리자만 되는 일**을 막을 때 씁니다 (결함 225). */
  myRole: string | null | undefined;
  save: ReturnType<typeof useSettingsMutations>['saveProject'];
  rotate: ReturnType<typeof useSettingsMutations>['rotateInvite'];
}) {
  const [value, setValue] = useState<string | null>(null);
  const input = value ?? title;
  const problem = titleProblem(input);
  /* ⚠️ 관리자만 되는 일 — 판단은 `@lib/project/roles.ts` 에 처음부터
     있었고 이 화면만 안 불렀습니다 (결함 225). */
  const renameBlocked = manageBlockedBecause(myRole, '프로젝트 이름 바꾸기');
  const titleBlocked = whyCannotSave({
    noPermission: renameBlocked,
    problem: value !== null ? problem : null,
    dirty: value !== null,
    saving: save.isPending,
  });
  const rotateBlocked = manageBlockedBecause(myRole, '초대 코드 새로 만들기');
  return (
    <div className="sec">
      <h2 className="sec__title">이름과 초대</h2>
      <label className="field">
        <span className="field__label">프로젝트 이름</span>
        <div className="sec__row">
          <input
            className="input"
            id="title-input"
            aria-invalid={problem !== null && value !== null}
            aria-describedby="title-problem"
            value={input}
            onChange={(e) => setValue(e.target.value)}
          />
          {/* ⚠️ **구성원에게도 멀쩡히 눌렸습니다** (결함 225). 서버는 403
              을 주는데 화면은 아무 말도 안 했습니다. `canManage` 는 처음부터
              `@lib` 에 있었고 이 화면만 안 불렀습니다. */}
          <button
            type="button"
            /* ⚠️ 권한(`renameBlocked`)은 `aria-disabled` 였는데 값 문제는
               `disabled` 였습니다 (결함 234) — 소유자가 이름을 비우면
               버튼이 **초점 밖으로** 사라졌습니다. */
            className={`btn btn--primary${titleBlocked !== null ? ' btn--unmet' : ''}`}
            aria-disabled={titleBlocked !== null}
            aria-describedby={titleBlocked !== null ? 'title-problem' : undefined}
            onClick={() => {
              if (save.isPending) return;
              if (titleBlocked !== null) {
                document.getElementById('title-input')?.focus();
                return;
              }
              save.mutate({ title: input.trim() }, { onSuccess: () => setValue(null) });
            }}
          >
            저장
          </button>
        </div>
      </label>
      <Problem id="title-problem" tone="incomplete">{titleBlocked}</Problem>
      <h3 className="pane__title" style={{ margin: 'var(--sp-6) 0 var(--sp-3)' }}>
        팀원 초대
      </h3>
      <div>
        <span className="invite-code">{inviteCode === '' ? '(없음)' : inviteCode}</span>
      </div>
      <div className="sec__row">
        <button
          type="button"
          className={`btn btn--secondary${rotateBlocked !== null ? ' btn--unmet' : ''}`}
          disabled={rotate.isPending}
          aria-disabled={rotateBlocked !== null}
          aria-describedby={rotateBlocked !== null ? 'rotate-blocked' : undefined}
          onClick={() => {
            if (rotateBlocked !== null) return;
            rotate.mutate();
          }}
        >
          코드 새로 만들기
        </button>
      </div>
      <Disclosure summary="코드를 새로 만들면 어떻게 되나요">
        <p>이전 코드는 그 즉시 무효가 됩니다. 이미 들어온 팀원은 그대로 남습니다.</p>
      </Disclosure>
      <Problem id="rotate-blocked" tone="incomplete">{rotateBlocked}</Problem>
      {/* ⚠️ **`rotate` 만 실패를 말할 자리가 없었습니다** (결함 225). 결함
          218 의 훑기 가드가 이걸 놓쳤는데, 그 가드가 **다음 600자 안의 다른
          mutate 의 `onError`** 를 보고 통과시켰기 때문입니다. */}
      <Problem>{rotate.isError ? mutationError(rotate.error) : null}</Problem>
      <Problem>{save.isError ? mutationError(save.error) : null}</Problem>
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
      {/* ⚠️ **결과 문구를 여기서 짓지 않습니다.**
          예전에는 이 자리에서 손으로 "원본 N건 · 성문 N건을 지웠습니다" 를
          찍었고, 그래서 **0건일 때도 "지웠습니다"** 라고 했습니다. 지울
          음성 자료가 애초에 없던 사람이 지워진 줄 알게 되는 것입니다 —
          개인정보보호법 제36조 삭제 요청의 결과 보고인데.

          판단(`describeOutcome`)은 처음부터 `@lib/privacy/deletion.ts` 에
          있었고 "0건을 성공으로만 답하지 않습니다" 라고 못까지 박아
          뒀는데, 레거시 화면만 그걸 부르고 있었습니다 — 결함 197 과 같은
          모양이고 이번이 다섯 번째입니다. */}
      {revoke.isSuccess &&
        (() => {
          const outcome = describeOutcome(revoke.data);
          return (
            <div className="notice" style={{ marginTop: 'var(--sp-5)' }} role="status">
              <p>{outcome.text}</p>
              {revoke.data.kept.map((k) => (
                <p className="t12" key={k}>
                  {k}
                </p>
              ))}
            </div>
          );
        })()}
      <Problem>{revoke.isError ? mutationError(revoke.error) : null}</Problem>
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
  /**
   * 내 권한 — **모르는 것과 없는 것을 가릅니다** (결함 254).
   *
   * `undefined` 는 「아직 모름」, `null` 은 「명단에 확실히 없음」입니다.
   * 예전에는 둘 다 `undefined` 라, 명단이 오기 전 몇 초 동안 **소유자에게**
   * 「팀의 관리자에게 요청하세요」라고 말했습니다. 재현했습니다 —
   * `/members` 를 4초 늦추고 여니 그 문장이 떠 있었고, 명단이 오자
   * 사라졌습니다. 잠그는 것은 그대로입니다(모르면 잠급니다). 고친 것은
   * **말**입니다.
   */
  const myRole = membersQuery.isSuccess ? (mine?.project_role ?? null) : undefined;

  /**
   * ⚠️ **못 불러온 것을 「0명」 이라고 단언하지 않습니다.**
   *
   * 서버가 404 를 준 프로젝트에서도 이 화면은 멀쩡한 설정 화면을 그리고
   * **「팀원 0명」** 이라고 말했습니다. 없는 프로젝트와 빈 팀을 사람이
   * 구별할 수 없었고, 위의 `?? []` 가 그 둘을 같은 값으로 만들고
   * 있었습니다(불변식 셋째 — 측정 불가 ≠ 0점).
   */
  const loadError = project.error ?? membersQuery.error;
  const cannotLoad =
    loadError == null
      ? null
      : describeLoadFailure(
          '프로젝트',
          loadError instanceof ApiError ? loadError.status : null,
        );

  const groups = [...new Set(SECTIONS.map((s) => s.group))];

  return (
    <AppShell
      title={project.data?.title ?? '설정'}
      docTitle={`설정 · ${project.data?.title ?? ''}`}
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
            {/* 못 불러왔으면 **여기서 멈춥니다.** 아래를 그리면 빈 값들이
                사실처럼 보입니다. */}
            {cannotLoad !== null && <Problem>{cannotLoad}</Problem>}
            {cannotLoad === null && section === 'role' && <RoleSection mine={mine} save={m.saveRole} />}
            {cannotLoad === null && section === 'github' && <GithubSection mine={mine} save={m.saveGithubLogin} />}
            {cannotLoad === null && section === 'profile' && <ProfileSection save={m.saveProfile} />}
            {cannotLoad === null && section === 'members' && (
              <MembersSection
                members={members}
                myRole={myRole}
                myUserId={me?.user_id}
                leave={m.leave}
                changeRole={m.changeRole}
                removeMember={m.removeMember}
              />
            )}
            {cannotLoad === null && section === 'repo' && (
              <RepoSection
                  myRole={myRole}
                projectId={projectId}
                repo={project.data?.github_repo ?? null}
                save={m.saveProject}
                backfill={m.backfill}
              />
            )}
            {section === 'general' && project.data && (
              <GeneralSection
                  myRole={myRole}
                title={project.data.title}
                inviteCode={project.data.invite_code}
                save={m.saveProject}
                rotate={m.rotateInvite}
              />
            )}
            {cannotLoad === null && section === 'danger' && <DangerSection revoke={m.revokeMyData} />}
            {m.openMeeting.isError && (
              <Problem>{mutationError(m.openMeeting.error)}</Problem>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
