function transformOffsetStart(offset, deleteLength, insertLength, targetOffset) {
  if (targetOffset < offset) {
    return targetOffset;
  }
  if (targetOffset === offset) {
    return offset;
  }
  if (targetOffset >= offset + deleteLength) {
    return targetOffset - deleteLength + insertLength;
  }
  return offset + insertLength;
}

function transformOffsetEnd(offset, deleteLength, insertLength, targetOffset) {
  if (targetOffset < offset) {
    return targetOffset;
  }
  if (targetOffset === offset) {
    return offset + insertLength;
  }
  if (targetOffset >= offset + deleteLength) {
    return targetOffset - deleteLength + insertLength;
  }
  return offset + insertLength;
}

function transformSpan(start, length, offset, deleteLength, insertLength) {
  const end = start + Math.max(0, length);
  const nextStart = transformOffsetStart(offset, deleteLength, insertLength, start);
  const nextEnd = transformOffsetEnd(offset, deleteLength, insertLength, end);
  return {
    start: nextStart,
    length: Math.max(0, nextEnd - nextStart),
  };
}

function transformEntry(entry, op) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (!entry.op || typeof entry.op !== 'object') {
    return entry;
  }

  const offset = Number(op?.p ?? 0);
  const deleteLength = typeof op?.d === 'string' ? op.d.length : 0;
  const insertLength = typeof op?.i === 'string' ? op.i.length : 0;
  const currentOffset = Number(entry.op.p ?? 0);
  const currentLength = typeof entry.op.c === 'string' ? entry.op.c.length : 0;
  const transformed = transformSpan(currentOffset, currentLength, offset, deleteLength, insertLength);

  return {
    ...entry,
    op: {
      ...entry.op,
      p: transformed.start,
      c: typeof entry.op.c === 'string' ? entry.op.c.slice(0, transformed.length) : entry.op.c,
    },
  };
}

export function transformRanges(ranges, ops) {
  if (!ranges || typeof ranges !== 'object') {
    return ranges ?? {};
  }

  let nextRanges = {
    ...ranges,
    comments: Array.isArray(ranges.comments) ? [...ranges.comments] : [],
    changes: Array.isArray(ranges.changes) ? [...ranges.changes] : [],
  };

  for (const op of ops || []) {
    nextRanges = {
      ...nextRanges,
      comments: nextRanges.comments.map((entry) => transformEntry(entry, op)),
      changes: nextRanges.changes.map((entry) => transformEntry(entry, op)),
    };
  }

  return nextRanges;
}
