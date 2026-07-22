import test from 'node:test';
import assert from 'node:assert/strict';
import { auditedDeleteResponse } from '../supabase/functions/api/deleteAudit.js';

test('audited deletes retain the existing success response', () => {
  assert.deepEqual(auditedDeleteResponse('delExpense', { ok: true }, null), {
    body: { ok: true },
    status: 200,
  });
});

test('fine deletion retains not-found and seven-day-window errors', () => {
  assert.deepEqual(auditedDeleteResponse('delFine', { error: 'fine_not_found' }, null), {
    body: { error: 'fine_not_found' },
    status: 404,
  });
  assert.deepEqual(auditedDeleteResponse('delFine', { error: 'fine_delete_window_expired' }, null), {
    body: { error: 'fine_delete_window_expired' },
    status: 403,
  });
});

test('RPC failures retain the standard API error envelope', () => {
  assert.deepEqual(auditedDeleteResponse('delDebt', null, { message: 'database unavailable' }), {
    body: { error: 'database unavailable' },
    status: 500,
  });
});
