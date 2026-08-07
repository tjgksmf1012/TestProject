/**
 * 기여도 화면.
 *
 * ⚠️ 화면 코드라 자동 테스트가 없습니다. 판단이 들어가는 것은 전부
 * `src/lib/contribution/view.ts` 에 있고 33개 테스트로 검증됩니다.
 * 여기는 DOM 배선일 뿐입니다 (`frontend/README.md` 의 경계 규칙).
 *
 * 이 화면에서 지켜야 하는 것 넷은 lib 쪽 주석에 적어 뒀습니다 —
 * 순위 금지 · 단일 점수 금지 · 측정 불가는 0점이 아님 · 시스템은 판정하지 않음.
 */

import {
  categoriesForDisplay,
  describeCategory,
  describeRange,
  hasNoEvidence,
  integrityNotes,
  nameOf,
  orderForDisplay,
  rangeBar,
  readBeforeTheNumber,
  teamWarnings,
  type MemberScore,
  type Person,
  type TeamScore,
} from '../lib/contribution/view.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { clearSkeleton, scoreCards, showSkeleton } from '../lib/ui/skeleton.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};

let people: Person[] = [];

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

const get = (path: string): Promise<Response> =>
  fetch(`${apiBase}${path}`, { credentials: 'same-origin', cache: 'no-store' });

/**
 * 마크다운 강조(`**측정하지 못했습니다**`)만 굵게 바꾼다.
 *
 * ⚠️ `escapeHtml` 을 **먼저** 걸고 그 다음에 별표만 태그로 바꿉니다.
 * 순서가 바뀌면 사람 이름에 들어간 `<` 가 태그가 됩니다.
 *
 * 이걸 안 하는 동안 화면에 `**측정하지 못했습니다**` 가 별표째 나왔습니다.
 * 문구 자체는 `lib/contribution/view.ts` 가 정하고, 여기서는 표시만 합니다.
 */
function withEmphasis(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function memberCard(member: MemberScore): string {
  const bar = rangeBar(member);
  const notes = readBeforeTheNumber(member);
  const flags = integrityNotes(member);
  const noEvidence = hasNoEvidence(member);

  const categories = categoriesForDisplay(member)
    .map((c) => {
      const share = Math.round(c.team_share * 100);
      return (
        `<li><span class="cat">${escapeHtml(describeCategory(c.category))}</span>` +
        `<span class="catbar"><i style="width:${share}%"></i></span>` +
        `<span class="catnum">${c.event_count}건</span></li>`
      );
    })
    .join('');

  return `
<article class="card">
  <header>
    <span class="who">${escapeHtml(nameOf(member.user_id, people))}</span>
    <span class="role">${escapeHtml(member.role)}</span>
  </header>

  <p class="range">${escapeHtml(describeRange(member))}</p>
  <div class="rangebar"><i style="left:${bar.left}%;width:${bar.width}%"></i></div>
  <p class="conf">신뢰도 ${escapeHtml(member.confidence_label)}</p>

  ${
    noEvidence
      ? '<p class="empty">이 사람의 활동이 아직 하나도 연결되지 않았습니다 — ' +
        '0 이라는 뜻이 아니라 <strong>연결이 없다</strong>는 뜻입니다.</p>'
      : ''
  }

  ${
    notes.length
      ? `<ul class="notes">${notes.map((n) => `<li>${withEmphasis(n)}</li>`).join('')}</ul>`
      : ''
  }

  ${categories ? `<ul class="cats">${categories}</ul>` : ''}

  ${
    flags.length
      ? `<ul class="flags">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
         <p class="flagnote">표시만 합니다 — 이 신호로 점수를 깎지 않습니다.
            판단은 팀이 합니다.</p>`
      : ''
  }
</article>`;
}

function render(score: TeamScore): void {
  const warnings = teamWarnings(score, people);
  $('warnings').hidden = warnings.length === 0;
  $('warnings').innerHTML = warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join('');

  $('notice').textContent = score.notice;
  $('meta').textContent = `${score.algo_version} · ${new Date(
    score.computed_at,
  ).toLocaleString('ko-KR')} 기준`;

  // ⚠️ 사람이 하나도 안 오면 카드 자리가 통째로 빕니다. 그 화면은
  // "아무도 아무것도 안 했다" 로 읽히는데, 실제로는 **아직 이을 활동이
  // 없다** 입니다. 이 프로젝트에서 그 둘을 섞는 것은 오답입니다
  // (docs/05 §5 — 측정 불가 ≠ 0점).
  if (score.members.length === 0) {
    $('members').innerHTML = emptyHtml({
      what: '여기에는 팀원별 기여 구간과 그 근거가 나옵니다.',
      why: '아직 이을 활동이 하나도 없습니다 — 아무도 안 했다는 뜻이 아닙니다.',
      how: '회의를 녹음하거나 GitHub 저장소를 연결하면 활동이 여기로 이어집니다.',
      action: { label: '프로젝트 설정', href: `/project.html?project=${projectId}` },
    });
    return;
  }

  $('members').innerHTML = orderForDisplay(score.members, people).map(memberCard).join('');
}

/** 받아 오기만 한다. **그리지 않는다** — `load()` 의 주석 참고. */
async function fetchAll(): Promise<
  { kind: 'expired' } | { kind: 'failed'; status: number } | { kind: 'ok'; score: TeamScore }
> {
  // ⭐ 명단은 **프로젝트** 단위. 회의 단위로 받던 동안에는 `?project=N`
  // 만으로 열면 이름이 전부 `사용자 #3` 이었고, 이름 순 정렬도 그 문자열
  // 순으로 바뀌었다 — 사람별 기여를 보여주는 화면에서 가장 나쁜 실패다.
  const [scoreRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/contributions`),
    get(`/api/projects/${projectId}/members`),
  ]);

  if (isSessionExpired(scoreRes.status)) return { kind: 'expired' };
  if (!scoreRes.ok) return { kind: 'failed', status: scoreRes.status };

  if (memberRes.ok) people = (await memberRes.json()) as Person[];
  return { kind: 'ok', score: (await scoreRes.json()) as TeamScore };
}

async function load(): Promise<void> {
  // ⚠️ 받아 오기와 그리기를 나눕니다. 스켈레톤을 걷는 것은
  // `whileLoading` 의 `finally` 라, 그 안에서 그리면 방금 그린 것을
  // 곧바로 지울 수 있습니다.
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($('members'), scoreCards()),
    () => clearSkeleton($('members')),
  );

  if (result.kind === 'expired') {
    goToLogin();
    return;
  }
  if (result.kind === 'failed') {
    // ⚠️ 카드 자리에 씁니다. 예전에는 위쪽 `#warnings` 에만 한 줄
    // 남겼는데, 그러면 카드 영역이 **텅 빈 채**로 있고 사람은
    // "아무도 아무것도 안 했구나" 로 읽습니다. 이 화면에서 그건
    // 버그가 아니라 오답입니다.
    $('members').innerHTML = failureHtml({
      what: '기여도를 불러오지 못했습니다.',
      help: describeHttpStatus(result.status) ?? undefined,
      code: `HTTP ${result.status}`,
      retry: true,
    });
    $('members')
      .querySelector<HTMLButtonElement>('.retry')
      ?.addEventListener('click', () => {
        void load();
      });
    return;
  }
  render(result.score);
}

async function start(): Promise<void> {
  const me = await get('/api/auth/me');
  if (!me.ok) {
    goToLogin();
    return;
  }
  $('who').textContent = `${((await me.json()) as Me).name} 님이 보고 있습니다`;
  await load();
}

void start();

renderNav('contributions');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
