export function auditedDeleteResponse(action, result, rpcError) {
  if (rpcError) {
    return { body: { error: rpcError.message }, status: 500 };
  }

  if (result?.ok === true) {
    return { body: { ok: true }, status: 200 };
  }

  const error = result?.error || 'delete_failed';
  if (action === 'delFine' && error === 'fine_not_found') {
    return { body: { error }, status: 404 };
  }
  if (action === 'delFine' && error === 'fine_delete_window_expired') {
    return { body: { error }, status: 403 };
  }

  return { body: { error }, status: 500 };
}
