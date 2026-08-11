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
  uncertaintyDots,
  uncertaintyDotsNote,
  uncertaintySpans,
  type UncertaintySpan,
  readBeforeTheNumber,
  roleOf,
  teamWarnings,
  type MemberScore,
  type Person,
  type TeamScore,
} from '../lib/contribution/view.ts';
import {
  adjustmentsToRestore,
  BLIND_CONFIRM,
  describeFinals,
  problemsWith,
  toPayload,
  type Draft,
  type FinalRow,
} from '../lib/contribution/final.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { escapeHtml } from '../lib/html.ts';
import { bylineHtml } from '../lib/ui/byline.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml, showNote } from '../lib/ui/failure.ts';
import { whileLoading, whilePressed } from '../lib/ui/pending.ts';
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
/** 마지막으로 그린 시스템 값. 확정 표가 이 값과 비교한다. */
let systemValues = new Map<number, number>();
/**
 * 저장된 확정을 **읽어 왔는가** (결함 97).
 *
 * ⚠️ 기본값은 `false` 입니다. 아직 못 읽은 것과 "확정이 없다" 는 다르고,
 * 헷갈리는 쪽으로 기울면 남의 조정을 지웁니다.
 */
let finalsKnown = false;

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

// ⚠️ **읽기도 `tryGet` 을 거칩니다** (결함 102). 맨 `fetch` 는 서버에
// 닿지 못하면 던지고, 그 뒤가 `void start()` 라 거부가 아무 데도 안
// 걸려 **카드 영역이 텅 빈 채로** 남았습니다.
const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

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

/**
 * 한 사람의 판독 줄.
 *
 * ## ⚠️ 카드에서 줄로 바꿨습니다 (docs/19 §16)
 *
 * 카드 셋을 가로로 늘어놓은 판형은 **어느 SaaS 화면과도 구분되지 않았고**,
 * 더 나쁘게는 이 화면이 하는 말과 어긋났습니다. 카드는 "완결된 결과" 처럼
 * 보이는 그릇인데, 여기 있는 것은 **범위와 신뢰도와 못 잰 구간**입니다.
 *
 * 지금은 제도 도면처럼 규칙선으로만 나눕니다 — 값은 글자로, 그림은
 * "얼마나 모르는가" 하나만.
 *
 * ## ⚠️ 구간의 **절대 위치를 그리지 않습니다**
 *
 * 세로 줄로 세우자 세 사람의 막대가 같은 0~100 축에 정렬됐고, 그 순간
 * 막대그래프이자 **순위표**가 됐습니다 (렌더해서 보고 알았습니다).
 * 값은 `describeRange` 가 글자로 정확히 말하므로 막대는 그 말의 반복일
 * 뿐이었고, 반복하는 쪽이 순위를 만들었습니다.
 */
function memberRow(member: MemberScore, uncertainty: UncertaintySpan | undefined): string {
  const notes = readBeforeTheNumber(member);
  const flags = integrityNotes(member);
  const noEvidence = hasNoEvidence(member);

  // ⭐ **막대를 걷어냈습니다** (docs/19 §22).
  //
  // 이 저장소가 기여도 막대에서 절대 위치를 뺄 때 세운 규칙이 있습니다 —
  // **"값은 글자로만 적고, 막대는 구간의 넓이만 그린다."** 세 사람을
  // 같은 0~100 축에 세로로 세우면 그건 순위표니까요.
  //
  // 그런데 카테고리 막대는 그대로 남아 있었습니다. `width: team_share%`
  // 짜리 막대가 세 줄에서 **같은 자리·같은 축**에 정렬돼 있었고, 그건
  // 방금 걷어낸 그 막대그래프와 똑같은 그림입니다.
  //
  // ⚠️ 숫자는 **지우지 않습니다.** 글자로 적으면 같은 정보가 더 정확하고
  // (막대는 40% 와 45% 를 구분해 주지 못합니다), 훑을 때 눈이 옆 사람
  // 줄로 미끄러지지 않습니다.
  const categories = categoriesForDisplay(member)
    .map(
      (c) =>
        `<li><span class="cat">${escapeHtml(describeCategory(c.category))}</span>` +
        `<span class="catnum">${c.event_count}건 · 팀의 ${Math.round(c.team_share * 100)}%</span></li>`,
    )
    .join('');

  // 폭 0 은 "완전히 확정" 이라 그릴 것이 없습니다. 0px 막대를 그리면
  // 사람은 그것을 "막대가 안 나왔다(고장)" 로 읽습니다.
  // ⭐ **막대에서 셀 수 있는 점으로** (docs/19 §26).
  //
  // 불확실성 시각화 연구가 한결같이 말하는 것은 빈도 표현이 연속 표현보다
  // 정확하게 읽힌다는 것입니다 — 사람은 길이를 눈대중하는 것보다 개수를
  // 세는 쪽을 훨씬 잘합니다.
  //
  // ⚠️ 그런데 원래 형태(quantile dotplot)는 **값 축 위에** 점을 뿌립니다.
  // 여기서 그러면 세 사람의 점이 같은 축에 세로로 정렬되고, 그건 이
  // 저장소가 이미 두 번 걷어낸 순위표입니다. 게다가 우리에게는 분포가
  // 없어서 점을 뿌리려면 **모양을 지어내야** 합니다.
  //
  // 그래서 기제만 가져왔습니다 — 위치가 아니라 **개수**로만.
  const dots = uncertaintyDots(uncertainty?.points ?? 0);
  const spread =
    dots === 0
      ? `<p class="unc-none">${escapeHtml(uncertaintyDotsNote(0))}</p>`
      : `<div class="unc-dots" role="img" aria-label="${escapeHtml(
          uncertaintyDotsNote(uncertainty?.points ?? 0),
        )}">${'<i></i>'.repeat(dots)}</div>` +
        `<p class="unc-note">${escapeHtml(uncertaintyDotsNote(uncertainty?.points ?? 0))}</p>`;

  return `
<div class="read">
  <div class="read-who">
    <span class="who">${escapeHtml(nameOf(member.user_id, people))}</span>
    <span class="role">${escapeHtml(roleOf(member, people))}</span>
  </div>

  <div class="read-val">
    <p class="range">${escapeHtml(describeRange(member))}</p>
    <p class="conf">신뢰도 ${escapeHtml(member.confidence_label)}</p>
    ${
      // ⚠️ 모르는 폭은 **숫자와 같은 칸**입니다. 제 열을 주면 8rem 을
      // 차지하면서 사유 칸을 좁히는데, 이건 바로 왼쪽 숫자에 딸린
      // 것이라 떨어뜨려 놓으면 무엇의 폭인지 안 보입니다.
      spread
    }
  </div>

  <div class="read-why">
    ${
      noEvidence
        ? '<p class="empty">이 사람의 활동이 아직 하나도 연결되지 않았습니다 — ' +
          '0 이라는 뜻이 아니라 <strong>연결이 없다</strong>는 뜻입니다.</p>'
        : ''
    }
    ${
      // ⚠️ **첫 줄만 보이고 나머지는 접습니다** (docs/19 §18).
      //
      // `readBeforeTheNumber` 는 측정 불가를 **맨 앞**에 놓습니다 — 이
      // 숫자를 얼마나 믿을지 정하는 가장 큰 요인이라 그렇게 정렬해
      // 뒀습니다. 그 판단을 여기서 그대로 씁니다: 맨 앞 하나는 늘 보이고,
      // 나머지 신뢰도 사유는 접힌 곳에 있습니다.
      //
      // 예전에는 셋이 다 깔려서 사람 셋이면 아홉 줄이었고, 그 아홉 줄이
      // 전부 비슷하게 생겨서 **정작 다른 한 줄(측정 불가)이 묻혔습니다.**
      notes.length
        ? `<ul class="notes"><li>${withEmphasis(notes[0] ?? '')}</li></ul>`
        : ''
    }
    ${categories ? `<ul class="cats">${categories}</ul>` : ''}
    ${moreHtml(notes.slice(1), flags)}
  </div>
</div>`;
}

/**
 * 줄의 접힌 서랍 — **지운 것이 아니라 접은 것** (docs/19 §18).
 *
 * 신뢰도 사유 나머지와 조작 신호가 여기 있습니다. DOM 에 그대로 남으므로
 * 낭독기도 브라우저 검색도 닿습니다.
 *
 * ⚠️ 조작 신호를 접는 것이 **감추는 것이 아닌** 이유: 이 신호는 원래
 * "표시만 하고 점수를 깎지 않는다" 는 것이었습니다(docs/05 §5). 항상
 * 펼쳐 두면 사람은 그것을 **판정**으로 읽습니다 — 접어 두는 편이 그
 * 원칙에 더 맞습니다.
 */
function moreHtml(rest: readonly string[], flags: readonly string[]): string {
  if (rest.length === 0 && flags.length === 0) return '';

  const body =
    (rest.length
      ? `<ul class="notes">${rest.map((n) => `<li>${withEmphasis(n)}</li>`).join('')}</ul>`
      : '') +
    (flags.length
      ? `<ul class="flags">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` +
        '<p class="flagnote">표시만 합니다 — 이 신호로 점수를 깎지 않습니다. 판단은 팀이 합니다.</p>'
      : '');

  const label = flags.length ? '신뢰도 사유와 표시' : '신뢰도 사유';
  return `<details class="more"><summary>${label}</summary><div class="more-body">${body}</div></details>`;
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

  const shown = orderForDisplay(score.members, people);
  // ⚠️ 폭 막대의 길이는 **팀에서 가장 넓은 구간** 기준이라, 한 사람만
  // 보고는 정할 수 없습니다. 그래서 목록 전체로 한 번에 계산합니다.
  const spans = new Map(uncertaintySpans(shown).map((s) => [s.userId, s]));
  $('members').innerHTML = shown
    .map((ms) => memberRow(ms, spans.get(ms.user_id)))
    .join('');

  systemValues = new Map(score.members.map((ms) => [ms.user_id, Number(ms.share.toFixed(3))]));
  renderFinalRows(score);
}

/** 확정 표. 한 줄 = 한 사람, 시스템 값과 확정값이 **나란히**. */
function renderFinalRows(score: TeamScore): void {
  const rows = orderForDisplay(score.members, people);
  $('finals').innerHTML = rows
    .map((ms) => {
      const name = escapeHtml(nameOf(ms.user_id, people));
      const system = (systemValues.get(ms.user_id) ?? 0).toFixed(1);
      return `<div class="final-row" data-user="${ms.user_id}">
        <span class="who">${name}</span>
        <span class="sys">시스템 ${system}%</span>
        <label>확정 <input type="number" class="val" step="0.1" min="0" max="100"
          placeholder="${system}" aria-label="${name} 확정값" /></label>
        <span class="why"><input type="text" class="reason"
          placeholder="시스템 값과 다르게 정했다면 이유" aria-label="${name} 조정 이유" /></span>
      </div>`;
    })
    .join('');
}

/** 화면의 입력 칸을 읽어 판단용 자료로. **판단은 `lib/contribution/final.ts` 가 한다.** */
function draftsFromScreen(): Draft[] {
  return [...$('finals').querySelectorAll<HTMLElement>('.final-row')].map((row) => {
    const raw = row.querySelector<HTMLInputElement>('.val')?.value.trim() ?? '';
    return {
      user_id: Number(row.dataset['user']),
      // 빈 칸은 **0 이 아니라 "안 건드렸다"** 다. Number('') 가 0 이라
      // 여기서 안 가르면 아무것도 안 적은 사람이 0점으로 확정된다.
      final_value: raw === '' ? null : Number(raw),
      reason: row.querySelector<HTMLInputElement>('.reason')?.value ?? '',
    };
  });
}

/**
 * 저장된 확정을 입력칸에 되돌려 놓는다 (결함 97).
 *
 * ⚠️ **판단은 `adjustmentsToRestore` 가 합니다.** 여기는 DOM 배선입니다.
 * 어느 칸을 채울지를 여기서 정하기 시작하면 브라우저 없이 못 잽니다.
 */
function restoreAdjustments(finals: FinalRow[]): void {
  const saved = adjustmentsToRestore(finals);
  for (const row of $('finals').querySelectorAll<HTMLElement>('.final-row')) {
    const mine = saved.get(Number(row.dataset['user']));
    const val = row.querySelector<HTMLInputElement>('.val');
    const reason = row.querySelector<HTMLInputElement>('.reason');
    // ⚠️ 되돌릴 것이 없으면 **비웁니다**. 남겨 두면 다시 그려진 표에
    // 지난 조정이 유령처럼 남습니다.
    if (val) val.value = mine === undefined ? '' : String(mine.final_value);
    if (reason) reason.value = mine?.reason ?? '';
  }
}

async function loadFinals(): Promise<void> {
  const response = await get(`/api/projects/${projectId}/contributions/final`);
  if (response === null || !response.ok) {
    // 확정 조회가 실패해도 기여도 화면은 살아 있어야 한다.
    // ⚠️ 다만 **확정은 막습니다** — 저장된 조정을 모르는 채로 확정하면
    // 남의 조정을 말없이 지웁니다 (결함 97).
    $('final-state').textContent = '';
    finalsKnown = false;
    return;
  }
  const body = (await response.json()) as { finals: FinalRow[] };
  const names = new Map(people.map((p) => [p.user_id, p.name]));
  $('final-state').textContent = describeFinals(body.finals, names);
  restoreAdjustments(body.finals);
  finalsKnown = true;
}

async function confirm(): Promise<void> {
  // ⚠️ 저장된 확정을 못 읽었으면 여기서 멈춥니다 (결함 97). 입력칸이
  // 비어 있는 것이 "시스템 값 그대로" 인지 "못 불러온 것" 인지 화면도
  // 구분 못 하는 상태라, 그대로 보내면 남의 조정을 지웁니다.
  if (!finalsKnown) {
    showNote($('final-message'), BLIND_CONFIRM);
    return;
  }

  const drafts = draftsFromScreen();
  const problems = problemsWith(drafts, systemValues);
  if (problems.length > 0) {
    // ⚠️ 서버도 같은 규칙으로 거절한다. 여기서 먼저 말하는 이유는,
    // 서버가 400 을 돌려준 뒤에 알려 주면 그때는 이미 다른 사람의
    // 확정까지 같이 실패한 뒤이기 때문이다.
    showNote($('final-message'), problems.join(' · '));
    return;
  }

  // ⚠️ 여기서 실패를 놓치면 화면에 **"확정했습니다."** 가 그대로 남는다.
  // 이 시스템에서 사람이 개입하는 유일한 지점이다 (docs/05 §5).
  const response = await trySend(() =>
    fetch(`${apiBase}/api/projects/${projectId}/contributions/final`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ finals: toPayload(drafts, systemValues) }),
      credentials: 'same-origin',
    }),
  );
  if (response === null) {
    showNote($('final-message'), unreachableText('확정하지 못했습니다'));
    return;
  }
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    // ⚠️ **`.json()` 도 던집니다.** 500 이 HTML 오류 페이지를 돌려주면
    // 파싱이 실패하고, 이 함수는 `whilePressed(…, confirm)` 안에서
    // 불리므로 거부가 아무 데도 안 걸립니다. 그러면 직전에 쓴
    // **"확정했습니다."** 가 화면에 그대로 남습니다 — 결함 87 이 고친
    // 바로 그 자리가 다른 길로 다시 열려 있었습니다.
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    showNote(
      $('final-message'),
      typeof body?.detail === 'string'
        ? body.detail
        : describeHttpStatus(response.status) ?? '확정하지 못했습니다',
    );
    return;
  }
  // ⚠️ 성공은 빨갛게 쓰지 않습니다 — 같은 자리라도 뜻이 다릅니다.
  showNote($('final-message'), '확정했습니다.', 'plain');
  await loadFinals();
}

/** 받아 오기만 한다. **그리지 않는다** — `load()` 의 주석 참고. */
async function fetchAll(): Promise<
  | { kind: 'expired' }
  | { kind: 'unreachable' }
  | { kind: 'failed'; status: number }
  | { kind: 'ok'; score: TeamScore }
> {
  // ⭐ 명단은 **프로젝트** 단위. 회의 단위로 받던 동안에는 `?project=N`
  // 만으로 열면 이름이 전부 `사용자 #3` 이었고, 이름 순 정렬도 그 문자열
  // 순으로 바뀌었다 — 사람별 기여를 보여주는 화면에서 가장 나쁜 실패다.
  const [scoreRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/contributions`),
    get(`/api/projects/${projectId}/members`),
  ]);

  // ⚠️ **닿지 못한 것을 만료로 읽지 않습니다.** 그러면 지하철에서 화면을
  // 연 사람이 이유도 모른 채 로그아웃당합니다.
  if (scoreRes === null) return { kind: 'unreachable' };
  if (isSessionExpired(scoreRes.status)) return { kind: 'expired' };
  if (!scoreRes.ok) return { kind: 'failed', status: scoreRes.status };

  if (memberRes?.ok) people = (await memberRes.json()) as Person[];
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
  if (result.kind === 'unreachable') {
    // 빈 카드 영역은 "아무도 아무것도 안 했다" 로 읽힙니다 — 이 화면에서
    // 그건 버그가 아니라 오답입니다.
    $('members').innerHTML = failureHtml({
      what: unreachableText('기여도를 불러오지 못했습니다.'),
      retry: true,
    });
    $('members')
      .querySelector<HTMLButtonElement>('.retry')
      ?.addEventListener('click', () => {
        void load();
      });
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
  await loadFinals();
}

async function start(): Promise<void> {
  const me = await get('/api/auth/me');
  if (me === null) {
    // 연결이 끊긴 것을 로그인 만료로 읽으면 안 됩니다. `load()` 가
    // 같은 이유로 실패하며 사람이 읽을 문장을 카드 자리에 씁니다.
    await load();
    return;
  }
  if (!me.ok) {
    goToLogin();
    return;
  }
  $('who').innerHTML = bylineHtml(((await me.json()) as Me).name, '보는 중');
  $('who').hidden = false;
  await load();
}

$('confirm').addEventListener('click', () => {
  // 확정은 **사람이 개입하는 유일한 지점**이다. 답이 늦다고 두 번
  // 누르면 같은 요청이 두 번 나간다 (결함 89).
  void whilePressed($('confirm') as HTMLButtonElement, confirm);
});

void start();

renderNav('contributions');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
