import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client.ts';
import type {
  Me,
  MeetingSummary,
  Member,
  ProjectDetail,
  ProjectSummary,
  RevokeResult,
  TracksResponse,
} from './types.ts';
import type { GithubHealth } from '@lib/github/health.ts';
import type { Task } from '@lib/kanban/board.ts';
import type { RosterEntry } from '@lib/lobby/room.ts';

/** 서버 `TaskBoardOut` 과 같은 모양. */
export interface TaskBoard {
  project_id: number;
  statuses: string[];
  tasks: Task[];
}
import type { TeamScore } from '@lib/contribution/view.ts';
import type { FinalRow, Payload } from '@lib/contribution/final.ts';
import type { Candidate, ReviewPayload } from '@lib/review/candidates.ts';
import type { TimelineUtterance } from '@lib/review/timeline.ts';
import type { UnresolvedIssue } from '@lib/review/minutes.ts';
import type { Finding } from '@lib/review/findings.ts';

/** 서버 `MeetingDetail` 과 같은 모양. */
export interface MeetingDetail {
  id: number;
  project_id: number;
  title: string | null;
  status: string;
  started_at: string;
  capture_mode: string;
  summary: string | null;
  next_agenda: string[];
  unresolved_issues: UnresolvedIssue[];
  findings: Finding[];
}

/** 서버 `TimelineOut` 과 같은 모양. */
export interface TimelineResponse {
  utterances: TimelineUtterance[];
  has_audio: boolean;
}

/** 서버 `ReviewResult` 와 같은 모양. */
export interface ReviewResult {
  approved_task_ids: number[];
  approved_count: number;
  failures: Record<number, string[]>;
}

/** 서버 `FinalsOut` 과 같은 모양. */
export interface FinalsOut {
  run_id: number;
  finals: FinalRow[];
  notice: string;
}

// 로그인 여부는 401 로 판별합니다 — 401 은 오류가 아니라 "로그인 전" 상태입니다.
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<Me | null> => {
      try {
        return await api.get<Me>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectSummary[]>('/api/projects'),
    enabled,
  });
}

export function useMeetings(projectId: number | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'meetings'],
    queryFn: () => api.get<MeetingSummary[]>(`/api/projects/${projectId}/meetings`),
    enabled: projectId !== undefined,
  });
}

export function useMembers(projectId: number | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'members'],
    queryFn: () => api.get<Member[]>(`/api/projects/${projectId}/members`),
    enabled: projectId !== undefined,
  });
}

export function useContributions(projectId: number | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'contributions'],
    queryFn: () => api.get<TeamScore>(`/api/projects/${projectId}/contributions`),
    enabled: projectId !== undefined,
  });
}

export function useFinals(projectId: number | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'finals'],
    queryFn: () => api.get<FinalsOut>(`/api/projects/${projectId}/contributions/final`),
    enabled: projectId !== undefined,
  });
}

export function useConfirmFinals(projectId: number | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (finals: Payload[]) =>
      api.post<FinalsOut>(`/api/projects/${projectId}/contributions/final`, { finals }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'finals'] });
    },
  });
}

/** 서버 `ProgressOut` 과 같은 모양. */
export interface MeetingProgress {
  stage: string | null;
  percent: number | null;
  detail: string;
  /** 화면에 그대로 쓸 한 줄. 서버와 화면이 **같은 문장**을 씁니다. */
  message: string;
  /**
   * 지금 다시 처리할 수 있는가 (결함 114).
   *
   * ⚠️ **판단은 서버가 합니다.** 화면이 `status` 를 보고 스스로 정하면
   * "언제 다시 처리할 수 있는가" 규칙이 두 곳에 생깁니다.
   */
  can_reprocess: boolean;
}

/**
 * 회의 처리 진행 상황.
 *
 * ⛔ SPA 로비는 이걸 **한 번도 안 물어봤습니다** (결함 231). 그래서
 * `can_reprocess` 가 화면에 닿지 않았고, 처리에 실패한 회의가
 * 「아래 트랙이 온전한지 확인하세요」 라고만 하고 **누를 것을 안 줬습니다.**
 */
export function useMeetingProgress(meetingId: number | undefined) {
  return useQuery({
    queryKey: ['meetings', meetingId, 'progress'],
    queryFn: () => api.get<MeetingProgress>(`/api/meetings/${meetingId}/progress`),
    enabled: meetingId !== undefined,
  });
}

/** 실패했거나 큐에 걸린 회의를 다시 처리합니다 (결함 114 · 231). */
export function useReprocess(meetingId: number | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ meeting_id: number; status: string; message: string }>(
        `/api/meetings/${meetingId}/reprocess`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['meetings', meetingId] });
      void queryClient.invalidateQueries({ queryKey: ['meetings', meetingId, 'progress'] });
    },
  });
}

export function useProject(projectId: number | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'detail'],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`),
    enabled: projectId !== undefined,
  });
}

export function useGithubHealth(projectId: number | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'github'],
    queryFn: () => api.get<GithubHealth>(`/api/projects/${projectId}/github`),
    enabled: projectId !== undefined,
  });
}

/** 설정 화면의 저장들 — 성공하면 관련 조회를 새로 고칩니다. */
export function useSettingsMutations(projectId: number | undefined) {
  const queryClient = useQueryClient();
  const refreshMembers = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'members'] });
  };
  const refreshProject = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'detail'] });
  };
  return {
    saveRole: useMutation({
      mutationFn: (role_shares: Record<string, number>) =>
        api.patch<Member>(`/api/projects/${projectId}/members/me`, { role_shares }),
      onSuccess: refreshMembers,
    }),
    saveGithubLogin: useMutation({
      mutationFn: (github_login: string) =>
        api.patch<Member>(`/api/projects/${projectId}/members/me/github`, { github_login }),
      onSuccess: refreshMembers,
    }),
    saveProfile: useMutation({
      mutationFn: (payload: { bio?: string; avatar?: string }) =>
        api.patch<Me>('/api/auth/me/profile', payload),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['me'] });
        refreshMembers();
      },
    }),
    saveProject: useMutation({
      mutationFn: (payload: { title?: string; github_repo?: string }) =>
        api.patch<ProjectDetail>(`/api/projects/${projectId}`, payload),
      onSuccess: () => {
        refreshProject();
        void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'github'] });
      },
    }),
    rotateInvite: useMutation({
      mutationFn: () => api.post<ProjectDetail>(`/api/projects/${projectId}/invite/rotate`),
      onSuccess: refreshProject,
    }),
    backfill: useMutation({
      mutationFn: () => api.post<unknown>(`/api/projects/${projectId}/github/backfill`, {}),
    }),
    leave: useMutation({
      mutationFn: () => api.post<void>(`/api/projects/${projectId}/members/me/leave`),
    }),
    /**
     * 팀원 등급 바꾸기 (`PROJECT-003`·`PROJECT-004`).
     *
     * ⚠️ 서버에는 처음부터 있었고 판단(`@lib/project/roles.ts`)도 있었는데
     *    **리디자인 SPA 만 안 부르고 있었습니다.** 레거시 화면이 부르고
     *    있어서 "아무도 안 쓰는 export" 가드도 통과했습니다 — 결함 197 과
     *    똑같은 모양입니다.
     */
    changeRole: useMutation({
      mutationFn: ({ userId, role }: { userId: number; role: string }) =>
        api.patch<Member>(`/api/projects/${projectId}/members/${userId}/role`, {
          project_role: role,
        }),
      onSuccess: refreshMembers,
    }),
    removeMember: useMutation({
      mutationFn: (userId: number) =>
        api.del<void>(`/api/projects/${projectId}/members/${userId}`),
      onSuccess: refreshMembers,
    }),
    revokeMyData: useMutation({
      mutationFn: () => api.post<RevokeResult>(`/api/projects/${projectId}/me/data`),
    }),
    openMeeting: useMutation({
      mutationFn: () =>
        api.post<{ meeting_id: number; project_id: number; status: string; consent_url: string }>(
          `/api/projects/${projectId}/meetings`,
          {},
        ),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'meetings'] });
      },
    }),
  };
}

export function useMeeting(meetingId: number | undefined) {
  return useQuery({
    queryKey: ['meetings', meetingId],
    queryFn: () => api.get<MeetingDetail>(`/api/meetings/${meetingId}`),
    enabled: meetingId !== undefined,
  });
}

export function useCandidates(meetingId: number | undefined) {
  return useQuery({
    queryKey: ['meetings', meetingId, 'candidates'],
    queryFn: () => api.get<Candidate[]>(`/api/meetings/${meetingId}/candidates`),
    enabled: meetingId !== undefined,
  });
}

export function useTimeline(meetingId: number | undefined) {
  return useQuery({
    queryKey: ['meetings', meetingId, 'timeline'],
    queryFn: () => api.get<TimelineResponse>(`/api/meetings/${meetingId}/timeline`),
    enabled: meetingId !== undefined,
  });
}

export function useMeetingMembers(meetingId: number | undefined) {
  return useQuery({
    queryKey: ['meetings', meetingId, 'members'],
    queryFn: () => api.get<Member[]>(`/api/meetings/${meetingId}/members`),
    enabled: meetingId !== undefined,
  });
}

export function useSubmitReview(meetingId: number | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReviewPayload) =>
      api.post<ReviewResult>(`/api/meetings/${meetingId}/candidates/review`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['meetings', meetingId, 'candidates'] });
      /* ⛔ **회의도 다시 읽습니다** (결함 233). 확정하면 회의 상태가
         `confirmed` 로 바뀌는데, 안 읽으면 화면이 옛 상태를 들고
         「결정한 후보가 없습니다」라고 합니다 — 새로고침해야 「검토를
         마쳤습니다」가 나왔습니다. */
      void queryClient.invalidateQueries({ queryKey: ['meetings', meetingId] });
    },
  });
}

export function useTasks(projectId: number | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'tasks'],
    queryFn: () => api.get<TaskBoard>(`/api/projects/${projectId}/tasks`),
    enabled: projectId !== undefined,
  });
}

export function useTaskMutations(projectId: number | undefined) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tasks'] });
  };
  return {
    patchTask: useMutation({
      // ⚠️ 값이 문자열만은 아닙니다 — `priority` 는 숫자입니다 (`TASK-007`).
      //    `Record<string, string>` 로 두면 화면이 `String(priority)` 를
      //    보내게 되고, 서버는 `"0"` 을 받아 pydantic 이 강제 변환합니다.
      //    운 좋게 돌지만 계약이 거짓말을 하게 됩니다.
      mutationFn: ({ taskId, patch }: { taskId: number; patch: Record<string, string | number | null> }) =>
        api.patch<Task>(`/api/projects/${projectId}/tasks/${taskId}`, patch),
      onSuccess: refresh,
    }),
    setAssignees: useMutation({
      mutationFn: ({ taskId, userIds }: { taskId: number; userIds: number[] }) =>
        api.put<Task>(`/api/projects/${projectId}/tasks/${taskId}/assignees`, {
          user_ids: userIds,
        }),
      onSuccess: refresh,
    }),
    deleteTask: useMutation({
      mutationFn: (taskId: number) =>
        api.del<void>(`/api/projects/${projectId}/tasks/${taskId}`),
      onSuccess: refresh,
    }),
  };
}

/** 서버 `ConsentOut` 과 같은 모양. */
export interface ConsentResponse {
  meeting_id: number;
  roster: RosterEntry[];
  all_confirmed: boolean;
  message: string;
}

export function useConsent(meetingId: number | undefined, refetchMs?: number) {
  return useQuery({
    queryKey: ['meetings', meetingId, 'consent'],
    queryFn: () => api.get<ConsentResponse>(`/api/meetings/${meetingId}/consent`),
    enabled: meetingId !== undefined,
    refetchInterval: refetchMs ?? false,
  });
}

export function useLobbyMutations(meetingId: number | undefined) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['meetings', meetingId, 'consent'] });
    void queryClient.invalidateQueries({ queryKey: ['meetings', meetingId, 'tracks'] });
  };
  return {
    consent: useMutation({
      mutationFn: (payload: { consent_type: string; consented: boolean }) =>
        api.post<ConsentResponse>(`/api/meetings/${meetingId}/consent`, payload),
      onSuccess: refresh,
    }),
    finish: useMutation({
      mutationFn: () => api.post<unknown>(`/api/meetings/${meetingId}/finish`),
      onSuccess: refresh,
    }),
  };
}

export function useTracks(meetingId: number | undefined, refetchMs?: number) {
  return useQuery({
    queryKey: ['meetings', meetingId, 'tracks'],
    queryFn: () => api.get<TracksResponse>(`/api/meetings/${meetingId}/tracks`),
    enabled: meetingId !== undefined,
    refetchInterval: refetchMs ?? false,
  });
}
