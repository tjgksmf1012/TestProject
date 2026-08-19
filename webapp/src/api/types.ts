// 서버 응답 형태. backend/teamflow/api/main.py 의 실제 페이로드를 옮겨 적은 것 —
// 여기 없는 필드를 쓰려면 먼저 서버 응답을 확인하십시오.

export interface Me {
  user_id: number;
  name: string;
  email: string;
  bio: string | null;
  /** `data:image/png;base64,…` 그대로. 파일 주소가 아닙니다. */
  avatar: string | null;
}

export interface ProjectSummary {
  project_id: number;
  title: string;
  member_count: number;
  meeting_count: number;
  needs_review: number;
}

/** 서버 상태 어휘: pending · queued · processing · needs_review · confirmed · failed */
export interface MeetingSummary {
  meeting_id: number;
  title: string | null;
  status: string;
  started_at: string;
  pending_candidates: number;
  /**
   * 트랙 커버리지 평균. **`null` 은 0 이 아니라 「못 쟀다」** 입니다
   * (docs/05 불변식 셋째). 아직 회의가 안 끝났으면 잰 적이 없습니다.
   */
  coverage: number | null;
}

/** ⚠️ 서버가 camelCase 로 보냅니다 (`recording_service.py`). */
export interface TrackGap {
  reason?: string;
  startMs: number;
  endMs: number;
}

export interface Track {
  track_id: number;
  user_id: number;
  status: string;
  coverage: number | null;
  total_gap_ms: number;
  capture_confidence: number | null;
  /** 녹음 기기가 남긴 경고 — 완료된 트랙에만 채워집니다. */
  warnings: { setting?: string; severity?: string; message?: string }[];
  stop_reason: string | null;
  gaps: TrackGap[];
  started_at: string | null;
  ended_at: string | null;
  chunk_count: number;
  silent_ms: number | null;
}

export interface TracksResponse {
  consent: { required: boolean; agreed_user_ids: number[] };
  tracks: Track[];
}

/** 서버 `MemberOut` 과 같은 모양 (필요한 칸만). */
export interface Member {
  user_id: number;
  name: string;
  role_shares: Record<string, number>;
  github_login: string | null;
  project_role: string;
  presence: string;
  bio: string | null;
  avatar: string | null;
}

/** 서버 `ProjectDetail` 과 같은 모양. */
export interface ProjectDetail {
  project_id: number;
  title: string;
  github_repo: string | null;
  github_connected: boolean;
  invite_code: string;
  member_count: number;
}

/** 서버 `RevokeOut` 과 같은 모양. */
export interface RevokeResult {
  deleted_assets: number;
  revoked_voiceprints: number;
  freed_bytes: number;
  failed: Record<number, string>;
  kept: string[];
}
