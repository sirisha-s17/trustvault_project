// Single place that decides whether a user may reach a document. Both the
// per-document middleware and the listing/search queries use these helpers,
// so the in-memory check and the MongoDB filter cannot drift apart.

function isGrantActive(grant, now = new Date()) {
  return !grant.expiresAt || new Date(grant.expiresAt) > now;
}

function findActiveGrant(document, userId, now = new Date()) {
  return (document.grants || []).find(
    (grant) => String(grant.userId?._id || grant.userId) === String(userId) && isGrantActive(grant, now)
  );
}

function hasPermission(document, user, requiredPermission, now = new Date()) {
  if (String(document.ownerId?._id || document.ownerId) === String(user._id)) {
    return true;
  }
  const grant = findActiveGrant(document, user._id, now);
  return Boolean(
    grant &&
      (grant.permission === requiredPermission ||
        (requiredPermission === "read" && grant.permission === "edit"))
  );
}

function activeGrantMatch(userId, now = new Date()) {
  return {
    grants: {
      $elemMatch: {
        userId,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
      }
    }
  };
}

function accessibleFilter(userId, now = new Date()) {
  return { $or: [{ ownerId: userId }, activeGrantMatch(userId, now)] };
}

function permissionFor(document, userId, now = new Date()) {
  if (String(document.ownerId?._id || document.ownerId) === String(userId)) {
    return "owner";
  }
  return findActiveGrant(document, userId, now)?.permission || null;
}

module.exports = {
  isGrantActive,
  findActiveGrant,
  hasPermission,
  activeGrantMatch,
  accessibleFilter,
  permissionFor
};
