/**
 * 아래 탭바와 (있으면) 위쪽 링크 줄을 그린다.
 *
 * 판단은 전부 `src/lib/nav/links.ts` 에 있고 27개 테스트가 붙습니다.
 * 여기는 DOM 에 붙이는 배선입니다 — 화면마다 복사하지 않으려고 뺐습니다.
 *
 * ## 왜 아래인가
 *
 * 폰을 한 손으로 쥐면 화면 위쪽 3분의 1은 엄지가 안 닿습니다. 그리고
 * 전체화면 PWA·WebView 로 띄우면 **주소창도 뒤로가기도 없습니다** —
 * 위쪽 링크 줄에 의존하던 이동이 그때는 정말 갇히는 길이 됩니다.
 */

import {
  contextFromSearch,
  missingLinks,
  navLinks,
  navTabs,
  type NavContext,
  type ScreenId,
} from '../lib/nav/links.ts';
import {
  channelAriaLabel,
  emptyChannelsNote,
  meetingChannels,
  shellHeading,
  type MeetingChannel,
} from '../lib/nav/channels.ts';
import {
  emptyMembersNote,
  panelHeading,
  panelMembers,
  unmeasurableNote,
  type Member,
} from '../lib/nav/panel.ts';
import {
  railAriaLabel,
  railIsWorthIt,
  railItems,
  type RailProject,
} from '../lib/nav/rail.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { escapeHtml } from '../lib/html.ts';
import { tryGet } from '../lib/http/send.ts';
import { safeApiBase } from '../lib/auth/session.ts';
import type { Meeting } from '../lib/home/next.ts';

/**
 * `<nav id="tabs">` 와 `<nav id="nav">` 이 있으면 채운다.
 *
 * 로그인 화면처럼 둘 다 없는 화면에서는 아무 일도 하지 않습니다.
 */
export function renderNav(current: ScreenId): void {
  const context = contextFromSearch(current, location.search);
  paint(context);

  const tabHost = document.getElementById('tabs');
  if (tabHost) void fillChannels(tabHost, context);
}

/**
 * 맥락 하나로 내비 전부를 다시 그린다.
 *
 * ## ⚠️ 왜 **다시** 그릴 수 있어야 하는가
 *
 * 로비·검토 화면은 주소에 `?meeting=` 만 있습니다. 그래서 처음 그릴 때
 * `projectId` 가 없고, `navTabs` 는 **칸반·기여도·설정 셋을 흐리게**
 * 만듭니다. 그런데 채널 목록을 채우려고 서버에 물으면 그 회의가 어느
 * 프로젝트인지 곧 알게 됩니다.
 *
 * 알고 나서 안 고치면 화면이 이렇게 됩니다 — 회의 채널 링크에는 전부
 * `project=1` 이 붙어 있는데, 바로 위 탭 셋은 "프로젝트를 고르면
 * 열립니다" 라고 말합니다. **같은 화면이 같은 것을 두고 서로 다른 말**을
 * 합니다. 브라우저로 로비를 열어 보고 알았습니다.
 *
 * ⚠️ `.chan` 은 **지웠다 다시 만들지 않고 옮겨 붙입니다.** 새로 만들면
 * 이미 받아 놓은 회의 목록이 날아가고, 다시 받을 때까지 목록이 깜빡입니다.
 */
interface ShellData {
  /** 열 머리말에 쓸 이름. 모르면 `null` */
  projectTitle?: string | null;
  /** 레일에 세울 프로젝트. 하나뿐이면 레일은 안 섭니다 */
  projects?: readonly RailProject[];
}

function paint(context: NavContext, shell: ShellData = {}): void {
  const tabHost = document.getElementById('tabs');
  if (tabHost) {
    const chan = tabHost.querySelector('.chan') ?? document.createElement('div');
    chan.className = 'chan';

    // 열 맨 위 — **지금 어느 프로젝트인가.** 이름을 아직 모르면
    // `shellHeading` 이 제품 이름을 줍니다. 비워 두면 열이 화면마다
    // 다른 높이에서 시작합니다.
    const name = shellHeading(shell.projectTitle);
    const heading = `<p class="chan-project" title="${escapeHtml(name)}">${escapeHtml(name)}</p>`;

    tabHost.innerHTML = navTabs(context)
      .map((tab) => {
        // 못 가는 탭은 `<a href>` 를 주지 않는다. 주면 눌렸을 때
        // `?project=null` 로 가고, 서버는 404 를 주고, 사람은 화면이
        // 고장 났다고 읽는다.
        const href = tab.enabled ? ` href="${escapeHtml(tab.href)}"` : '';
        const disabled = tab.enabled ? '' : ' aria-disabled="true"';
        const marked = tab.current ? ' aria-current="page"' : '';
        const title = tab.blockedReason
          ? ` title="${escapeHtml(tab.blockedReason)}"`
          : '';
        return (
          `<a${href}${disabled}${marked}${title}>` +
          // ⚠️ `iconSvg` 는 **이스케이프하지 않습니다.** `icons.ts` 의
          // 상수 마크업이라 안전하고, 이스케이프하면 태그가 글자로
          // 나옵니다. 그 파일이 상수만 담는지는 테스트가 고정합니다.
          `<span class="ico">${iconSvg(tab.icon)}</span>` +
          `<span>${escapeHtml(tab.label)}</span>` +
          `</a>`
        );
      })
      .join('');

    // ⚠️ 머리말은 탭 **앞**에 넣습니다. `innerHTML` 에 같이 이어 붙이지
    // 않는 이유는 위 `.map` 이 탭만 만드는 자리이기 때문입니다 — 거기에
    // 다른 것을 섞으면 다음 사람이 탭 마크업을 고칠 때 같이 건드립니다.
    tabHost.insertAdjacentHTML('afterbegin', heading);

    // 탭 넷 **뒤에** 회의 채널이 붙습니다. 서버에서 회의를 받아 오면
    // 그때 채웁니다 — 자세한 건 `fillChannels` 참고.
    tabHost.append(chan);

    // 셋째 열 — 맥락 패널. `#tabs` 밖이라 **body 끝에** 답니다.
    //
    // ⚠️ 자리는 `position: fixed` 가 잡습니다. DOM 순서는 화면 배치와
    // 상관없지만 **낭독기와 탭 이동 순서**에는 그대로 걸립니다. 본문보다
    // 앞에 두면 화면을 열 때마다 팀원 명단을 먼저 듣게 됩니다.
    if (document.querySelector('.ctx') === null) {
      const panel = document.createElement('aside');
      panel.className = 'ctx';
      document.body.append(panel);
    }

    paintRail(context, shell.projects ?? []);
  }

  const host = document.getElementById('nav');
  if (!host) return;

  const links = navLinks(context)
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join('');
  const notes = missingLinks(context)
    .map((note) => `<span class="miss">${escapeHtml(note)}</span>`)
    .join('');

  host.innerHTML = links + notes;
}

// ══════════════════════════════════════════════════════════════
// 프로젝트 레일
// ══════════════════════════════════════════════════════════════

/**
 * 맨 왼쪽 72px.
 *
 * ⚠️ **`body.has-rail` 로 자리를 잡습니다.** CSS 는 프로젝트가 몇 개인지
 * 모르므로, 세울지 말지를 여기서 정해 클래스로 알려 줍니다. 클래스가
 * 없으면 채널 목록이 `left: 0` 에 그대로 붙습니다 — 레일이 없을 때
 * **72px 이 비지 않는** 것이 이 방식의 요점입니다 (docs/19 §11).
 */
function paintRail(context: NavContext, projects: readonly RailProject[]): void {
  const existing = document.querySelector('.rail');

  if (!railIsWorthIt(projects)) {
    // 하나뿐이면 세우지 않습니다. 이미 서 있었다면 걷어냅니다 —
    // 프로젝트를 나가면 레일도 같이 사라져야 합니다.
    existing?.remove();
    document.body.classList.remove('has-rail');
    return;
  }

  const rail = existing instanceof HTMLElement ? existing : document.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', '프로젝트');

  rail.innerHTML = railItems(projects, context.current, context.projectId)
    .map((item) => {
      const current = item.current ? ' aria-current="page"' : '';
      // 검토거리는 **점 하나**입니다. 개수는 홈과 채널 목록이 말합니다 —
      // 72px 안에 숫자를 넣으면 글자가 4px 짜리가 됩니다.
      const dot = item.needsReview ? `<span class="rail-dot"></span>` : '';
      return (
        `<a class="rail-item" href="${escapeHtml(item.href)}"${current}` +
        ` title="${escapeHtml(item.label)}"` +
        ` aria-label="${escapeHtml(railAriaLabel(item))}">` +
        `<span class="rail-face" aria-hidden="true">${escapeHtml(item.initial)}</span>` +
        dot +
        `</a>`
      );
    })
    .join('');

  // ⚠️ 본문보다 **앞**에 답니다. 레일은 화면 맨 왼쪽이고, 낭독기와 탭
  // 이동도 그 순서로 읽는 것이 맞습니다. 맥락 패널이 뒤에 붙는 것과
  // 짝입니다 — 그쪽은 곁다리라 본문 뒤입니다.
  if (existing === null) document.body.prepend(rail);
  document.body.classList.add('has-rail');
}

// ══════════════════════════════════════════════════════════════
// 회의 채널
// ══════════════════════════════════════════════════════════════

/**
 * 셸이 서는 너비. `app.css` 의 `@media (min-width: 90rem)` 과 **같은 값**
 * 이어야 합니다.
 *
 * ⚠️ 두 벌입니다. CSS 에서 JS 로 이 숫자를 읽어 올 방법이 마땅치 않아
 * 어쩔 수 없이 적었고, 대신 `guards.test.ts` 가 둘이 같은지 봅니다.
 */
const SHELL_WIDTH = '(min-width: 90rem)';

/**
 * 맥락 패널이 서는 너비. **채널 목록보다 넓습니다.**
 *
 * 90rem(1440px)에서 셋째 열까지 세우면 본문에 836px 밖에 안 남고, 칸반은
 * 거기서 열 셋을 나눠 써야 합니다 — 한 열이 270px 이 됩니다. 카드 안에
 * "연결된 PR이 없습니다 — PR 제목이나 본문에 TASK-3을 적으면 붙습니다"
 * 같은 문장이 들어가는 화면이라 그 폭에서는 글이 뭉갭니다.
 *
 * 그래서 패널은 100rem(1600px)부터입니다. 그 사이 폭에서는 **두 열**로
 * 섭니다 — 접히는 게 아니라 원래 모양입니다.
 */
const PANEL_WIDTH = '(min-width: 100rem)';

const CHANNEL_LIMIT = 20;

/**
 * 이 화면이 어느 프로젝트인지 확정하고, 셸이 서 있으면 채널을 채운다.
 *
 * ## 왜 둘로 갈랐는가
 *
 * 이 함수가 하는 일은 **폰에서도 뜻이 있고**, `listChannels` 가 하는 일은
 * 아닙니다.
 *
 *     프로젝트 확정   탭 넷의 절반이 여기에 달려 있다 → 어느 화면에서나
 *     회의 목록       셸이 설 때만 보인다             → 넓을 때만
 *
 * 처음엔 하나였고 맨 앞에서 너비를 봤습니다. 그랬더니 폰의 로비에서
 * 칸반·기여도·설정이 흐린 채로 남았습니다.
 */
async function fillChannels(tabHost: HTMLElement, context: NavContext): Promise<void> {
  const apiBase = safeApiBase(new URLSearchParams(location.search).get('api'), location.origin);
  const projectId = await resolveProjectId(apiBase, context);
  if (projectId === null) return;

  // ⭐ 로비·검토에서는 여기서 처음으로 프로젝트를 알게 됩니다. 알았으면
  // 탭도 다시 그립니다 — 안 그리면 채널 링크에는 `project=1` 이 붙어
  // 있는데 바로 위 탭 셋은 "프로젝트를 고르면 열립니다" 로 남습니다.
  //
  // ⚠️ **이건 폰에서도 합니다.** 채널 목록은 폰에서 안 보이지만 탭 넷은
  // 보입니다. 처음엔 너비를 먼저 보고 좁으면 통째로 돌아갔는데, 그러면
  // 폰의 로비에서 칸반·기여도·설정 셋이 흐린 채로 남습니다 — 주소창도
  // 뒤로가기도 없는 PWA 에서 그건 **갇히는 길**입니다. 브라우저로
  // 390px 로비를 열어 보고 알았습니다.
  const projects = await fetchProjects(apiBase);
  const title = projects.find((p) => p.project_id === projectId)?.title ?? null;
  if (context.projectId !== projectId || title !== null) {
    paint({ ...context, projectId }, { projectTitle: title, projects });
  }

  await Promise.all([
    listChannels(tabHost, apiBase, { ...context, projectId }),
    fillPanel(apiBase, projectId),
  ]);
}

/**
 * 맥락 패널 — 셋째 열. **패널이 설 만큼 넓을 때만** 받아 옵니다.
 *
 * 담는 것과 왜 계획보다 좁은지는 `lib/nav/panel.ts` 에 적어 뒀습니다.
 */
async function fillPanel(apiBase: string, projectId: number): Promise<void> {
  const host = document.querySelector('.ctx');
  if (!(host instanceof HTMLElement)) return;

  const wide = window.matchMedia(PANEL_WIDTH);
  if (!wide.matches) {
    wide.addEventListener('change', () => void fillPanel(apiBase, projectId), { once: true });
    return;
  }

  const response = await tryGet(`${apiBase}/api/projects/${projectId}/members`);
  // ⚠️ 닿지 못한 것과 팀원이 없는 것은 다릅니다. 그런데 이 패널은
  // **본문이 아니라 곁다리**라, 못 받았다고 빨간 말을 띄우면 화면이
  // 하려던 일과 상관없는 경고가 옆에 섭니다. 조용히 비웁니다 —
  // `.ctx:empty` 가 열 자체를 접습니다.
  if (response === null || !response.ok) return;

  const members = panelMembers((await response.json()) as Member[]);
  if (members.length === 0) {
    host.innerHTML = `<p class="ctx-note">${escapeHtml(emptyMembersNote())}</p>`;
    return;
  }

  const rows = members
    .map((row) => {
      const roles =
        row.roles === null ? '' : `<p class="ctx-roles">${escapeHtml(row.roles)}</p>`;
      // 못 재는 사람의 점에만 이유를 답니다. 마우스를 올리면 뜹니다.
      const why = row.note === null ? '' : ` title="${escapeHtml(row.note)}"`;
      return (
        `<div class="ctx-row" aria-label="${escapeHtml(row.ariaLabel)}">` +
        `<p class="ctx-name">` +
        `<span class="ctx-dot" data-state="${escapeHtml(row.state)}"${why}></span>` +
        `${escapeHtml(row.name)}</p>` +
        roles +
        `</div>`
      );
    })
    .join('');

  const note = unmeasurableNote(members);
  host.innerHTML =
    `<p class="ctx-head">${escapeHtml(panelHeading(members.length))}</p>` +
    rows +
    (note === null ? '' : `<p class="ctx-note">${escapeHtml(note)}</p>`);
}

/**
 * 내가 속한 프로젝트 전부.
 *
 * 열 머리말(이름)과 레일(전환)이 **같은 응답**을 씁니다. 따로 부르면 같은
 * 것을 두 번 받아 오고, 두 응답이 어긋나는 순간(그 사이에 프로젝트가
 * 하나 생기면) 머리말과 레일이 서로 다른 말을 합니다.
 *
 * ⚠️ **`GET /api/projects/{id}` 를 쓰지 않습니다.** 그쪽은 `ProjectDetail`
 * 이라 **초대 코드**를 함께 줍니다 ("초대 코드는 구성원에게만"). 이름
 * 하나 때문에 그것을 칸반·기여도·로비·검토 **네 화면 메모리로 끌고
 * 들어갈 이유가 없습니다.** 목록 쪽(`ProjectSummary`)에는 초대 코드가
 * 없고, 홈이 이미 쓰는 엔드포인트라 모양도 하나입니다.
 *
 * 못 받으면 빈 배열 — 부르는 쪽이 제품 이름으로 대신하고 레일은 안 섭니다.
 */
async function fetchProjects(apiBase: string): Promise<RailProject[]> {
  const response = await tryGet(`${apiBase}/api/projects`);
  if (response === null || !response.ok) return [];
  const body = (await response.json()) as unknown;
  return Array.isArray(body) ? (body as RailProject[]) : [];
}

/**
 * 회의 목록을 받아 채널로 그린다. **셸이 설 때만** 합니다.
 *
 * ⚠️ 데이터가 오기 전에 "없습니다" 를 쓰지 않습니다 — 위 문단 참고.
 */
async function listChannels(
  tabHost: HTMLElement,
  apiBase: string,
  context: NavContext,
): Promise<void> {
  const wide = window.matchMedia(SHELL_WIDTH);
  if (!wide.matches) {
    // 한 번만 기다립니다. 넓어졌다 좁아졌다를 반복해도 요청은 한 번입니다.
    wide.addEventListener('change', () => void listChannels(tabHost, apiBase, context), {
      once: true,
    });
    return;
  }

  const host = tabHost.querySelector('.chan');
  if (!(host instanceof HTMLElement)) return;

  const projectId = context.projectId;
  const response = await tryGet(`${apiBase}/api/projects/${projectId}/meetings`);
  if (response === null) {
    // ⚠️ 서버에 닿지 못한 것과 회의가 없는 것은 다릅니다. 같은 자리에
    // 같은 회색 글씨로 "없습니다" 를 쓰면 사람은 회의가 사라진 줄 압니다.
    host.innerHTML =
      `<p class="chan-head">회의</p>` +
      `<p class="chan-none">목록을 불러오지 못했습니다 — 연결을 확인해 주세요</p>`;
    return;
  }
  // ⚠️ `!ok` 일 때는 **아무 말도 하지 않습니다.** 401 이면 화면이 곧 로그인으로
  // 보내고, 404 면 그 화면이 자기 말로 설명합니다. 여기서 한 번 더 말하면
  // 사라질 화면 위에 경고가 겹칩니다.
  if (!response.ok) return;

  const meetings = (await response.json()) as Meeting[];
  const channels = meetingChannels(meetings, {
    projectId,
    currentMeetingId: context.meetingId,
  });

  host.innerHTML =
    `<p class="chan-head">회의</p>` +
    (channels.length === 0
      ? `<p class="chan-none">${escapeHtml(emptyChannelsNote())}</p>`
      : renderChannels(channels));
}

/**
 * 이 화면이 어느 프로젝트의 것인가.
 *
 * 로비·검토 화면은 주소에 `?meeting=` 만 있습니다. 그 회의가 어느
 * 프로젝트인지는 서버만 알고 있으므로 한 번 물어봅니다 — 안 물어보면
 * **회의 안에 들어가는 순간 채널 목록이 통째로 사라집니다.**
 */
async function resolveProjectId(
  apiBase: string,
  context: NavContext,
): Promise<number | null> {
  if (context.projectId != null && context.projectId > 0) return context.projectId;
  if (context.meetingId == null || context.meetingId <= 0) return null;

  const response = await tryGet(`${apiBase}/api/meetings/${context.meetingId}`);
  if (response === null || !response.ok) return null;
  const meeting = (await response.json()) as { project_id?: number };
  return typeof meeting.project_id === 'number' ? meeting.project_id : null;
}

/**
 * ⚠️ **`<ul><li>` 를 쓰지 않습니다.** 이 마크업은 `#tabs` 안에 들어가는데,
 * `lobby.html`·`index.html` 이 `ul` 에 자기 규칙을 걸어 두어 셸 안에서
 * 조용히 모양이 깨집니다 (docs/19 §10).
 *
 * ⚠️ 목록이 길어지면 **자릅니다.**
 *
 * 처음엔 "스크롤이 생기면 탭 넷이 밀려 올라간다" 를 이유로 적었는데,
 * 그건 CSS 로 이미 막았습니다 (탭은 `flex-shrink: 0`, 목록만 스크롤).
 * 34개를 넣고 브라우저로 확인했습니다 — **틀린 이유였습니다.**
 *
 * 진짜 이유는 이겁니다: 사이드바는 **훑어 찾는 곳이 아닙니다.** 거르는
 * 수단도 검색도 없는 목록에서 백 줄을 굴리는 것은 목록이 아니라 벽이고,
 * 우리는 최근 것부터 주므로 위 스물이면 지금 볼 것은 다 들어옵니다.
 * 전부 봐야 할 때 가는 곳은 홈입니다 — 거기는 자르지 않습니다
 * (`home.ts` 의 `projectHtml` 이 받은 것을 전부 그립니다).
 *
 * 자른 것은 자른 만큼 말해 줍니다 — 조용히 숨기면 "회의가 사라졌다" 가
 * 됩니다.
 */
function renderChannels(channels: MeetingChannel[]): string {
  const shown = channels.slice(0, CHANNEL_LIMIT);
  const rows = shown
    .map((channel) => {
      const current = channel.current ? ' aria-current="page"' : '';
      const count =
        channel.pending === null
          ? ''
          : `<span class="chan-count">${escapeHtml(String(channel.pending))}</span>`;
      return (
        `<a class="chan-row" href="${escapeHtml(channel.href)}"${current}` +
        ` aria-label="${escapeHtml(channelAriaLabel(channel))}">` +
        `<span class="chan-dot" data-state="${escapeHtml(channel.state)}"></span>` +
        `<span class="chan-name">${escapeHtml(channel.label)}</span>` +
        count +
        `</a>`
      );
    })
    .join('');

  const hidden = channels.length - shown.length;
  const more =
    hidden === 0
      ? ''
      : `<p class="chan-none">그 밖에 ${escapeHtml(String(hidden))}개 — 홈에서 전부 봅니다</p>`;
  return rows + more;
}
