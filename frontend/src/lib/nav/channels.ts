/**
 * 회의를 **채널**로 — 채널 목록에 세울 회의 항목을 만든다.
 *
 * ## 왜 회의가 채널이어야 하는가
 *
 * 지금 회의는 **장소가 아니라 페이지**입니다. 홈에서 회의를 눌러 로비로
 * 가고, 칸반을 보러 가면 회의에서 나온 것이 됩니다. 그런데 이 제품에서
 * 회의는 **들어가고 나오는 방**입니다 — 통화가 붙고 녹음이 돌고 사람이
 * 그 안에 있습니다. 디스코드의 음성 채널과 같은 것입니다.
 *
 * 근거는 `docs/19-메신저-셸-전환.md` 입니다.
 *
 * ## ⚠️ 상태 어휘를 새로 만들지 않습니다
 *
 * `lib/home/next.ts` 에 `MEETING_STATUS_LABEL` 과 `nextStepFor` 가 이미
 * 있고, `test_repo_integrity.py` 가 서버의 `MeetingStatus` 와 그 표를
 * 맞춰 놓았습니다. 여기서 두 번째 표를 만들면 **한쪽만 고쳐집니다** —
 * 이 저장소가 반복해서 당한 그것입니다. 그래서 라벨은 저쪽에서 가져오고,
 * 이 파일은 **채널로 그릴 때만 필요한 것**(점의 종류·주소)만 정합니다.
 */

import { describeMeetingStatus, type Meeting } from '../home/next.ts';
import { meetingLabel } from '../ui/naming.ts';

/**
 * 채널 옆 점이 무엇을 뜻하는가.
 *
 * ⚠️ **`gap`(결측)을 여기 넣지 않습니다.** 이건 회의의 상태이지 측정
 * 가능 여부가 아닙니다. 커버리지는 로비와 기여도 화면이 말합니다.
 */
export type ChannelState =
  /** 지금 사람이 들어가 있을 수 있는 방. 통화·녹음이 살아 있다 */
  | 'open'
  /** 서버가 처리 중. 눌러도 아직 볼 것이 없다 */
  | 'working'
  /** 사람이 할 일이 남았다 */
  | 'todo'
  /** 끝난 회의 */
  | 'done'
  /** 처리에 실패했다 */
  | 'failed';

export interface MeetingChannel {
  meetingId: number;
  /** 화면에 보이는 이름 */
  label: string;
  href: string;
  state: ChannelState;
  /** 상태를 사람 말로. 툴팁·낭독기에 쓴다 */
  stateLabel: string;
  /** 지금 보고 있는 회의인가 */
  current: boolean;
  /**
   * 아직 결정 안 한 후보 수. **0 이면 `null`** 입니다.
   *
   * ⚠️ 0 을 배지로 그리면 "0건 남음" 이라는 뜻 없는 표가 붙습니다.
   */
  pending: number | null;
}

const STATE: Record<string, ChannelState> = {
  pending: 'open',
  queued: 'working',
  processing: 'working',
  needs_review: 'todo',
  confirmed: 'done',
  failed: 'failed',
};

/**
 * 모르는 상태는 **`working`** 으로 봅니다.
 *
 * ⚠️ `done` 으로 보면 사람이 "끝났구나" 로 읽고 다시 안 봅니다. 모르는
 * 것을 끝난 것으로 그리는 쪽이 그 반대보다 나쁩니다. 서버에 상태가
 * 하나 더 생겼는데 화면이 아직 모르는 상황이 정확히 이 자리입니다.
 */
export function channelState(status: string): ChannelState {
  return STATE[status] ?? 'working';
}

/**
 * 이름 없는 회의를 어떻게 부를 것인가.
 *
 * ⚠️ 서버는 `title` 을 `null` 로 줄 수 있습니다. 빈 글자를 그대로 그리면
 * 목록에 **누를 수는 있는데 이름이 없는 줄**이 생깁니다.
 *
 * ⚠️ 예전에는 여기서 직접 `회의 {번호}` 를 지었습니다 (결함 285). 채널
 * 목록은 **모든 화면에 늘 떠 있는데**, 같은 회의를 머리줄은 「제목 없는
 * 회의 #4」, 왼쪽 목록은 「회의 4」라고 불렀습니다. 이름은 한 벌에서
 * 옵니다 — 여기서는 `Meeting` 모양을 그 한 벌에 넘겨 주기만 합니다.
 */
export function channelLabel(meeting: Meeting): string {
  return meetingLabel(meeting.title, meeting.meeting_id);
}

/**
 * 채널을 눌렀을 때 갈 곳.
 *
 * ⭐ **프로젝트 번호를 함께 들고 갑니다.** `navLinks` 는 로비 주소를
 * `?meeting=N` 으로만 만드는데, 그러면 로비에 도착한 순간 주소에
 * 프로젝트가 없어서 **칸반·기여도·설정 탭 셋이 흐려집니다**
 * (`navTabs` 가 `projectId` 없이는 못 간다고 판단합니다). 로비 화면은
 * 자기가 서버에 물어 프로젝트를 알아내지만 그건 탭이 이미 그려진
 * 뒤입니다.
 *
 * 채널 목록은 **모든 화면에 늘 떠 있는 이동 수단**이라 이 구멍이 훨씬
 * 크게 벌어집니다 — 회의를 한 번 누르면 그 뒤로 갈 곳이 줄어듭니다.
 * 여기서는 프로젝트를 이미 알고 있으므로 주소에 실어 보냅니다.
 */
export function channelHref(meetingId: number, projectId?: number | null): string {
  const base = `/lobby.html?meeting=${meetingId}`;
  return projectId != null && projectId > 0 ? `${base}&project=${projectId}` : base;
}

export interface ChannelContext {
  /** 채널을 딸 프로젝트. 없으면 목록을 만들 수 없습니다 */
  projectId?: number | null;
  /** 지금 보고 있는 회의 */
  currentMeetingId?: number | null;
}

/**
 * 회의 목록 → 채널 목록.
 *
 * ⚠️ **순서를 바꾸지 않습니다.** 서버가 최근 것부터 줍니다
 * (`list_project_meetings` — "오래된 것부터 두면 회의가 쌓일수록 지금 볼
 * 것이 아래로 밀립니다"). 여기서 다시 정렬하면 그 판단이 두 벌이 됩니다.
 */
export function meetingChannels(
  meetings: readonly Meeting[],
  context: ChannelContext = {},
): MeetingChannel[] {
  const { projectId, currentMeetingId } = context;
  return meetings.map((meeting) => ({
    meetingId: meeting.meeting_id,
    label: channelLabel(meeting),
    href: channelHref(meeting.meeting_id, projectId),
    state: channelState(meeting.status),
    stateLabel: describeMeetingStatus(meeting.status),
    current: currentMeetingId != null && currentMeetingId === meeting.meeting_id,
    pending: meeting.pending_candidates > 0 ? meeting.pending_candidates : null,
  }));
}

/**
 * 회의가 하나도 없을 때 그 자리에 쓸 말.
 *
 * ⚠️ 빈 목록을 그냥 비워 두면 **고장으로 읽힙니다.** 이 저장소는 빈 상태에
 * "무엇이 오는가 · 왜 지금 비었는가 · 무엇을 하면 되는가" 셋을 말하기로
 * 정해 뒀습니다(`lib/ui/empty.ts`). 채널 목록은 자리가 좁으니 한 줄로
 * 줄이되 **무엇을 하면 되는지는 남깁니다.**
 */
export function emptyChannelsNote(): string {
  return '아직 연 회의가 없습니다 — 설정에서 엽니다';
}

/**
 * 채널 목록 맨 위에 무엇을 쓸 것인가 — **지금 어느 프로젝트인가.**
 *
 * ## 왜 필요한가
 *
 * 프로젝트 이름을 말하는 화면이 **`project.html` 하나뿐**입니다. 칸반·
 * 기여도·로비·검토는 제목이 "칸반"·"회의 로비" 이고, 어느 프로젝트의
 * 것인지는 주소의 `?project=3` 에만 있습니다. 프로젝트가 둘 이상인
 * 사람은 **자기가 어느 팀 화면을 보고 있는지 알 방법이 없습니다.**
 *
 * 슬랙의 작업공간 이름이 늘 왼쪽 위에 있는 것과 같은 자리입니다.
 *
 * ⚠️ **못 부르는 이름을 비워 두지 않습니다.** 홈에는 프로젝트 맥락이
 * 없는데, 그렇다고 그 자리를 비우면 열이 화면마다 다른 높이에서
 * 시작합니다. 프로젝트 위의 이름은 제품 이름입니다.
 */
export function shellHeading(projectTitle?: string | null): string {
  const title = (projectTitle ?? '').trim();
  return title === '' ? 'TeamFlow' : title;
}

/**
 * 개수 알약에 **뭐라고 적을 것인가** (결함 350).
 *
 * ## ⛔ 숫자만 적어서 귀가 눈보다 많이 알고 있었습니다
 *
 * 알약은 `3` 한 글자였고 낭독기만 「업무 후보 3건 검토 대기」를 들었습니다.
 * 결함 336 이 홈의 리본에서 잡은 것과 **같은 모양**입니다 — 축 이름이
 * `aria-label` 에만 있으면 눈으로 보는 사람이 값을 다른 뜻으로 읽습니다.
 *
 * 그리고 여기서는 **읽힐 다른 뜻이 이미 정해져 있습니다.** 이 셸은
 * 일부러 메신저를 본떴고(`docs/19`), 그 세계에서 채널 이름 옆의 둥근
 * 알약은 **안 읽은 개수**입니다. 이 제품에도 안 읽은 알림이 있고 같은
 * 모양(`--r-round` + 강조 채움)으로 그립니다 — 다만 그쪽은 「안 읽은
 * 알림」이라는 글자를 달고 있습니다.
 *
 * 세어 보니 두 뿌리의 세는 알약 **여섯 중 다섯**이 바로 앞에 축 이름을
 * 답니다(「할 일 2」·「검토 필요 3」·「안 읽은 알림 3」·「{n}명」·「업무 4」).
 * 이름을 안 다는 것은 이 하나뿐이었습니다.
 *
 * ⚠️ 그래서 **글자를 늘리는 게 아니라 옮깁니다** — 이미 `aria-label` 에
 * 있던 말을 눈에도 보이게 두 글자로 줄여 적습니다.
 */
export function channelCountText(pending: number | null): string | null {
  return pending === null ? null : `후보 ${pending}`;
}

/**
 * 채널 하나를 낭독기에 뭐라고 읽어 줄 것인가.
 *
 * ⚠️ 점은 **눈으로만 읽히는 표시**입니다. 그것뿐이면 낭독기 사용자에게는
 * 회의 이름만 남습니다 — 어느 방이 열려 있는지가 통째로 사라집니다.
 *
 * ⚠️ 개수는 이제 **눈에도 축 이름이 있습니다**(`channelCountText`).
 * 여기서는 그것을 풀어 씁니다 — 낭독기는 줄여 쓸 이유가 없습니다.
 */
export function channelAriaLabel(channel: MeetingChannel): string {
  const parts = [channel.label, channel.stateLabel];
  if (channel.pending !== null) parts.push(`업무 후보 ${channel.pending}건 검토 대기`);
  return parts.join(', ');
}
