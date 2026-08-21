/**
 * 프로필 이미지·자기소개 (`USER-004`) 의 판단.
 *
 * ## ⚠️ 사진 원본은 서버로 가지 않습니다
 *
 * 화면이 캔버스에 다시 그려 96×96 PNG 로 재부호화한 것만 보냅니다.
 * 원본을 그대로 보내면 EXIF(찍은 위치·기기)까지 저장하게 됩니다 —
 * 프로필 사진 한 장에 그 사람의 **집 좌표**가 들어 있을 수 있습니다.
 * 재부호화를 거치면 픽셀만 남습니다.
 *
 * 서버(`users/profile.py`)가 최종 판정을 하고 여기서는 왕복이 명백히
 * 낭비인 것만 잡습니다 — `validateLogin` 과 같은 규칙입니다.
 */

/** 아바타 한 변(px). 서버 상한(192)의 절반 — 기기 배율 2배까지 여유. */
export const AVATAR_SIDE = 96;

/** 서버 `users/profile.py` 의 `MAX_BIO` 와 같아야 한다. */
export const MAX_BIO = 300;

/**
 * 고른 파일 자체의 상한. 재부호화 **전**에 봅니다 — 수백 MB 를 캔버스에
 * 올리고 나서 상한을 재면 이미 브라우저가 멈춘 뒤입니다.
 */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/** 사진 고르기 옆에 반드시 붙는 말 — 원본이 안 가는 것을 화면이 말합니다. */
export const PHOTO_NOTE =
  '사진은 96×96으로 줄여 저장합니다 — 원본과 위치 정보(EXIF)는 서버로 가지 않습니다.';

/**
 * 고른 파일을 캔버스에 올리기 **전**에 잡을 수 있는 문제.
 *
 * ⚠️ `accept="image/*"` 는 안내이지 제약이 아닙니다 — 파일 고르기 창은
 * "모든 파일" 로 바꿀 수 있습니다.
 */
export function photoProblem(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) {
    return '이미지 파일이 아닙니다';
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return `사진이 너무 큽니다 (${Math.round(file.size / 1024 / 1024)}MB) — 20MB까지 받습니다`;
  }
  return null;
}

/**
 * 지금 보여 줄 사진 (결함 265).
 *
 * ⚠️ **빈 글은 「지움」입니다.** 서버도 같은 규약입니다
 * (`users/profile.py` 의 `clean_avatar("")` → `None`). 화면에서 `?? ` 로만
 * 이으면 빈 글이 「안 고침」과 섞여, 지우기를 누른 뒤에도 옛 사진이 그대로
 * 남습니다.
 *
 * - `pending === null` — 아직 안 건드림 → 저장된 것
 * - `pending === ''`   — 지우기를 눌렀음 → 없음
 * - 그 밖         — 새로 고른 사진
 */
export function avatarToShow(pending: string | null, saved: string | null | undefined): string | null {
  if (pending === '') return null;
  return pending ?? saved ?? null;
}

/** 자기소개의 문제. 없으면 `null`. 빈 글은 문제가 아니라 "지움" 입니다. */
export function bioProblem(text: string): string | null {
  const length = text.trim().length;
  if (length > MAX_BIO) {
    return `자기소개는 ${MAX_BIO}자까지입니다 (지금 ${length}자)`;
  }
  return null;
}

/**
 * 가운데 정사각형 잘라내기 — `drawImage` 의 원본 좌표.
 *
 * 눌러 맞추면(비율 무시) 얼굴이 길쭉해집니다. 짧은 변에 맞춰 가운데를
 * 자릅니다.
 */
export function coverCrop(width: number, height: number): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height);
  return {
    sx: Math.floor((width - size) / 2),
    sy: Math.floor((height - size) / 2),
    size,
  };
}
