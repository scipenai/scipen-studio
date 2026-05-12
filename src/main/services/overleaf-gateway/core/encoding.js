export function decodeLegacyUtf8(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return Buffer.from(value, 'latin1').toString('utf-8');
}

function decodeJoinedRangeEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (!entry.op || typeof entry.op !== 'object') {
    return { ...entry };
  }

  const nextOp = { ...entry.op };
  if (typeof nextOp.c === 'string') {
    nextOp.c = decodeLegacyUtf8(nextOp.c);
  }
  if (typeof nextOp.i === 'string') {
    nextOp.i = decodeLegacyUtf8(nextOp.i);
  }
  if (typeof nextOp.d === 'string') {
    nextOp.d = decodeLegacyUtf8(nextOp.d);
  }

  return {
    ...entry,
    op: nextOp,
  };
}

export function decodeJoinedRanges(rawRanges) {
  let parsed = rawRanges;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  return {
    ...parsed,
    comments: Array.isArray(parsed.comments) ? parsed.comments.map((entry) => decodeJoinedRangeEntry(entry)) : [],
    changes: Array.isArray(parsed.changes) ? parsed.changes.map((entry) => decodeJoinedRangeEntry(entry)) : [],
  };
}
