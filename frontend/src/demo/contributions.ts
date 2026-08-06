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
import { isSessionExpired, loginUrlFor, type Me } from '../lib/auth/session.ts';
import { escapeHtml } from '../lib/html.ts';

const params = new URLSearchParams(location.search);
const apiBase = params.get('api') ?? '';
const projectId = Number(params.get('project') ?? '1');
// 이름을 붙이려면 명단이 필요한데, 명단 API 는 회의 단위다.
const meetingId = params.get('meeting');

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
  <div class="track"><i style="left:${bar.left}%;width:${bar.width}%"></i></div>
  <p class="conf">신뢰도 ${escapeHtml(member.confidence_label)}</p>

  ${
    noEvidence
      ? '<p class="empty">이 사람의 활동이 아직 하나도 연결되지 않았습니다 — ' +
        '0 이라는 뜻이 아니라 <strong>연결이 없다</strong>는 뜻입니다.</p>'
      : ''
  }

  ${
    notes.length
      ? `<ul class="notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
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

  $('members').innerHTML = orderForDisplay(score.members, people).map(memberCard).join('');
}

async function load(): Promise<void> {
  const [scoreRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/contributions`),
    meetingId ? get(`/api/meetings/${meetingId}/members`) : Promise.resolve(null),
  ]);

  if (isSessionExpired(scoreRes.status)) {
    goToLogin();
    return;
  }
  if (!scoreRes.ok) {
    $('warnings').hidden = false;
    $('warnings').textContent =
      scoreRes.status === 403
        ? '이 프로젝트의 구성원만 기여도를 볼 수 있습니다.'
        : `기여도를 불러오지 못했습니다 (HTTP ${scoreRes.status})`;
    return;
  }

  if (memberRes?.ok) people = (await memberRes.json()) as Person[];
  render((await scoreRes.json()) as TeamScore);
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
