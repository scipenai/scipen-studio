import crypto from 'node:crypto';

function clonePatch(patch) {
  return {
    offset: Number(patch.offset ?? 0),
    deleteCount: Number(patch.deleteCount ?? 0),
    insertText: String(patch.insertText ?? ''),
  };
}

export function normalizeOffsetPatches(patches) {
  return (patches || [])
    .map(clonePatch)
    .filter((patch) => patch.deleteCount > 0 || patch.insertText.length > 0)
    .sort((left, right) => right.offset - left.offset);
}

export function applyOffsetPatches(content, patches) {
  let nextContent = content;
  for (const patch of normalizeOffsetPatches(patches)) {
    const start = Math.max(0, Math.min(patch.offset, nextContent.length));
    const end = Math.max(start, Math.min(start + patch.deleteCount, nextContent.length));
    nextContent = `${nextContent.slice(0, start)}${patch.insertText}${nextContent.slice(end)}`;
  }
  return nextContent;
}

export function offsetPatchesToOverleafOps(content, patches) {
  const normalized = normalizeOffsetPatches(patches);
  const ops = [];

  for (const patch of normalized) {
    const start = Math.max(0, Math.min(patch.offset, content.length));
    const deleteEnd = Math.max(start, Math.min(start + patch.deleteCount, content.length));
    const deleted = content.slice(start, deleteEnd);

    if (deleted.length > 0) {
      ops.push({ p: start, d: deleted });
    }
    if (patch.insertText.length > 0) {
      ops.push({ p: start, i: patch.insertText });
    }
  }

  return ops;
}

export function applyOverleafOps(content, ops) {
  let nextContent = content;
  const normalized = [...(ops || [])].sort((left, right) => {
    const leftPos = Number(left?.p ?? 0);
    const rightPos = Number(right?.p ?? 0);
    return rightPos - leftPos;
  });

  for (const op of normalized) {
    const position = Math.max(0, Math.min(Number(op?.p ?? 0), nextContent.length));
    if (typeof op?.d === 'string' && op.d.length > 0) {
      nextContent = `${nextContent.slice(0, position)}${nextContent.slice(position + op.d.length)}`;
    }
    if (typeof op?.i === 'string' && op.i.length > 0) {
      nextContent = `${nextContent.slice(0, position)}${op.i}${nextContent.slice(position)}`;
    }
  }

  return nextContent;
}

export function overleafOpsToOffsetPatches(ops) {
  const merged = new Map();

  for (const op of ops || []) {
    const offset = Number(op?.p ?? 0);
    const current = merged.get(offset) ?? {
      offset,
      deleteCount: 0,
      insertText: '',
    };
    if (typeof op?.d === 'string') {
      current.deleteCount += op.d.length;
    }
    if (typeof op?.i === 'string') {
      current.insertText += op.i;
    }
    merged.set(offset, current);
  }

  return Array.from(merged.values())
    .filter((patch) => patch.deleteCount > 0 || patch.insertText.length > 0)
    .sort((left, right) => right.offset - left.offset);
}

export function computeGitBlobSha1(content) {
  return crypto.createHash('sha1').update(`blob ${content.length}\x00${content}`).digest('hex');
}
