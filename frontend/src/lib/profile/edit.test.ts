import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { avatarToShow, bioProblem, coverCrop, MAX_BIO, PHOTO_NOTE, photoProblem } from './edit.ts';

describe('프로필 이미지·자기소개 (USER-004)', () => {
  it('이미지가 아닌 파일을 캔버스에 올리기 전에 잡는다', () => {
    assert.match(photoProblem({ type: 'application/pdf', size: 100 }) ?? '', /이미지 파일이/);
    assert.equal(photoProblem({ type: 'image/jpeg', size: 100 }), null);
  });

  it('너무 큰 파일은 몇 MB 인지까지 말한다', () => {
    const problem = photoProblem({ type: 'image/png', size: 30 * 1024 * 1024 });
    assert.match(problem ?? '', /30MB/);
  });

  it('자기소개 상한을 넘으면 지금 몇 자인지 말한다', () => {
    assert.equal(bioProblem('백엔드를 맡고 있습니다'), null);
    assert.match(bioProblem('가'.repeat(MAX_BIO + 1)) ?? '', /301자/);
    // 빈 글은 문제가 아니다 — "지움" 이다.
    assert.equal(bioProblem(''), null);
  });

  it('가운데 정사각형을 자른다 — 눌러 맞추면 얼굴이 길쭉해진다', () => {
    assert.deepEqual(coverCrop(400, 300), { sx: 50, sy: 0, size: 300 });
    assert.deepEqual(coverCrop(300, 400), { sx: 0, sy: 50, size: 300 });
    assert.deepEqual(coverCrop(96, 96), { sx: 0, sy: 0, size: 96 });
  });

  it('원본이 서버로 가지 않는 것을 화면이 말한다', () => {
    assert.match(PHOTO_NOTE, /EXIF/);
    assert.match(PHOTO_NOTE, /서버로 가지 않습니다/);
  });
});


describe('avatarToShow (결함 265)', () => {
  it('⭐ **빈 글은 「지움」이다** — 「안 고침」과 다르다', () => {
    assert.equal(avatarToShow('', 'data:image/png;base64,AAA'), null);
    assert.equal(avatarToShow(null, 'data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  });

  it('새로 고른 사진이 이긴다', () => {
    assert.equal(avatarToShow('data:image/png;base64,BBB', 'data:image/png;base64,AAA'), 'data:image/png;base64,BBB');
  });

  it('둘 다 없으면 없음', () => {
    assert.equal(avatarToShow(null, null), null);
    assert.equal(avatarToShow(null, undefined), null);
  });
});
