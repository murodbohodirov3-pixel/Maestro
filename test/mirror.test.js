import test from 'node:test';
import assert from 'node:assert/strict';
import { latestScanPerClient, MIRROR_SCAN_HOURS, scannedAgo } from '../supabase/functions/_shared/mirror.js';
import { botText, mirrorStartCode, mirrorStartUrl } from '../supabase/functions/_shared/bookingCore.js';

test('a master QR opens the clients’ bot with its code, and only such a code is read back', () => {
  assert.equal(mirrorStartUrl('MaestroBarberia_bot', '0a1b2c3d4e'), 'https://t.me/MaestroBarberia_bot?start=m_0a1b2c3d4e');
  assert.equal(mirrorStartCode('/start m_0a1b2c3d4e'), '0a1b2c3d4e');
  assert.equal(mirrorStartCode('/start@MaestroBarberia_bot m_0a1b2c3d4e '), '0a1b2c3d4e');
  assert.equal(mirrorStartCode('/start m_0A1B2C3D4E'), null);
  assert.equal(mirrorStartCode('/start m_0a1b2c'), null);
  assert.equal(mirrorStartCode('/start b_0a1b2c3d4e'), null);
  assert.equal(mirrorStartCode('m_0a1b2c3d4e'), null);
});

test('a scan stays two hours, and a client who scanned twice is shown once, the newest', () => {
  assert.equal(MIRROR_SCAN_HOURS, 2);
  const rows = [
    { id: 1, scanned_at: '2026-10-22T08:00:00Z', client: { id: 'a', full_name: 'Сардор Каримов' } },
    { id: 2, scanned_at: '2026-10-22T08:20:00Z', client: { id: 'b', full_name: 'Тимур Алиев' } },
    { id: 3, scanned_at: '2026-10-22T08:30:00Z', client: { id: 'a', full_name: 'Сардор Каримов' } },
    { id: 4, scanned_at: '2026-10-22T08:40:00Z', client: { id: 'c', full_name: 'Блок', lifecycle_status: 'blocked' } },
    { id: 5, scanned_at: '2026-10-22T08:50:00Z', client: null },
  ];
  assert.deepEqual(latestScanPerClient(rows).map((row) => row.id), [3, 2]);
  assert.deepEqual(latestScanPerClient(null), []);
});

test('how long ago, in the words the master reads', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  assert.equal(scannedAgo('2026-10-22T09:59:40Z', now), 'только что');
  assert.equal(scannedAgo('2026-10-22T09:55:00Z', now), '5 мин назад');
  assert.equal(scannedAgo('2026-10-22T08:50:00Z', now), '1 ч 10 мин назад');
  assert.equal(scannedAgo('2026-10-22T08:00:00Z', now), '2 ч назад');
  assert.equal(scannedAgo('2026-10-22T10:01:00Z', now), 'только что');
});

test('the mirror questions exist in both languages and never ask for the Telegram name', () => {
  for (const lang of ['ru', 'uz']) {
    const text = botText(lang);
    assert.match(text.mirrorAskContact('Жавохир'), /Жавохир/);
    assert.match(text.mirrorDone('Сардор', 'Жавохир'), /Сардор[\s\S]*Жавохир/);
    assert.ok(text.mirrorAskFirst && text.mirrorAskLast && text.mirrorAskKnown && text.mirrorBadName);
  }
  assert.equal(botText('ru').mirrorPickLang, botText('uz').mirrorPickLang);
});
