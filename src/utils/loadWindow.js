// Windowed refresh support.
//
// `load` used to answer with every row of every table. The tables that record
// daily activity — sales, shifts, fines, expenses, debt payments — grow for as
// long as the salon stays open, so a poll every 15 seconds cost more each month
// while returning almost the same rows. The client now sends a lower bound on
// its polls and merges the answer into what it already holds.
//
// The bound applies only to those accumulating tables. Balances and reference
// data are small and bounded by the business, not by time, so they keep coming
// back whole.

// Collections the server may return windowed, and the column it bounds each by.
export const WINDOWED_COLLECTIONS = {
  sales: 'd',
  fines: 'd',
  attendance: 'd',
  expenses: 'date',
  debtPayments: 'date',
};

export function rowDate(row, primary = 'd') {
  return row?.[primary] || row?.date || row?.sale_date || row?.attendance_date || row?.fine_date || '';
}

export function localDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// A poll has to cover what the day, week and month views show plus the previous
// period each compares against. The deepest of those is last month.
export function pollWindowStart(now = new Date()) {
  return localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

// A windowed response is authoritative for its window and silent about the rest,
// so replace the window and keep older rows. Replacing rather than appending is
// what makes edits and deletions inside the window appear: a row deleted on the
// server is simply absent from the replacement, and disappears with it.
//
// The cost of the bound: a record older than the window that gets edited or
// deleted stays stale on screen until the next unbounded load. App.jsx asks for
// one whenever the app returns to the foreground.
export function mergeWindowedData(previous, incoming, since) {
  const merged = { ...incoming };

  for (const [collection, column] of Object.entries(WINDOWED_COLLECTIONS)) {
    const outsideWindow = (previous?.[collection] || []).filter((row) => {
      const date = rowDate(row, column);
      // An undated row can never come back in a bounded response, so the
      // window says nothing about it and it has to be kept.
      return !(date && date >= since);
    });

    merged[collection] = [...outsideWindow, ...(incoming?.[collection] || [])];
  }

  return merged;
}
