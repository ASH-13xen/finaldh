import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';

// One active session per student account (admins are exempt):
// - A session ends after SESSION_IDLE_MINUTES without any API activity (the frontend
//   heartbeats while the tab is visible, so an open tab keeps it alive).
// - A *different* device can only sign in once the account has been inactive for
//   SESSION_SWITCH_LOCK_MINUTES - logging out on the old device starts that clock, so
//   handing an account to someone else always costs an hour. The same device can sign
//   back in immediately.
const minutes = (value, fallback) => {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60 * 1000;
};
export const SESSION_IDLE_MS = minutes(process.env.SESSION_IDLE_MINUTES, 60);
export const SESSION_SWITCH_LOCK_MS = minutes(process.env.SESSION_SWITCH_LOCK_MINUTES, 60);

// lastSeenAt is only written when it's this stale, so ordinary browsing doesn't turn
// every request into a DB write.
export const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

// Short human label for the "active on ..." message, e.g. "Chrome on Windows".
export const describeDevice = (userAgent = '') => {
  const ua = userAgent.toLowerCase();
  const browser =
    ua.includes('edg/') ? 'Edge' :
    ua.includes('opr/') || ua.includes('opera') ? 'Opera' :
    ua.includes('samsungbrowser') ? 'Samsung Internet' :
    ua.includes('firefox') || ua.includes('fxios') ? 'Firefox' :
    ua.includes('chrome') || ua.includes('crios') ? 'Chrome' :
    ua.includes('safari') ? 'Safari' : 'a browser';
  const os =
    ua.includes('android') ? 'Android' :
    ua.includes('iphone') || ua.includes('ipad') ? 'iOS' :
    ua.includes('windows') ? 'Windows' :
    ua.includes('mac os') ? 'Mac' :
    ua.includes('linux') ? 'Linux' : 'an unknown device';
  return `${browser} on ${os}`;
};

// Returns null when this device may sign in now, otherwise details of the session
// blocking it.
export const getLoginBlock = (user, deviceId, now = Date.now()) => {
  if (isAdminEmail(user.email)) return null;
  const s = user.session;
  if (!s?.lastSeenAt || !s.deviceId || s.deviceId === deviceId) return null;
  const unlockAt = s.lastSeenAt.getTime() + SESSION_SWITCH_LOCK_MS;
  if (now >= unlockAt) return null;
  return {
    device: s.device || 'another device',
    loggedOut: !s.id,
    retryAt: new Date(unlockAt).toISOString(),
  };
};

// Starts a fresh session on this device (replacing any previous one) and returns the JWT.
export const startSession = async (user, deviceId, userAgent) => {
  const sid = crypto.randomUUID();
  const now = new Date();
  user.session = {
    id: sid,
    deviceId,
    device: describeDevice(userAgent),
    startedAt: now,
    lastSeenAt: now,
  };
  await user.save();
  return jwt.sign(
    { userId: user._id, email: user.email, sid },
    process.env.JWT_SECRET || 'fallback_secret',
    { expiresIn: '7d' }
  );
};
