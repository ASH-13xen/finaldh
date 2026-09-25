import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { isAdminEmail } from './adminMiddleware.js';
import { SESSION_IDLE_MS, LAST_SEEN_WRITE_INTERVAL_MS } from '../utils/session.js';

// 401 + code tells the frontend to drop its token and show why (see main.jsx).
const endSession = (res, code, error) => res.status(401).json({ code, error });

// Enforces the single active session from utils/session.js: the token's sid must be the
// account's current session and it must not have idled out. Admins skip this.
const checkSession = async (decoded, res) => {
  if (isAdminEmail(decoded.email)) return true;
  if (!decoded.sid) {
    endSession(res, 'SESSION_INVALID', 'Please sign in again.');
    return false;
  }

  const user = await User.findById(decoded.userId, { session: 1 }).lean();
  const s = user?.session;
  if (!s?.id || s.id !== decoded.sid) {
    endSession(res, s?.id ? 'SESSION_REPLACED' : 'SESSION_INVALID',
      s?.id ? 'You were signed out because this account signed in again.' : 'Please sign in again.');
    return false;
  }

  const idleFor = Date.now() - new Date(s.lastSeenAt).getTime();
  if (idleFor > SESSION_IDLE_MS) {
    endSession(res, 'SESSION_EXPIRED', 'You were signed out after a period of inactivity.');
    return false;
  }
  if (idleFor > LAST_SEEN_WRITE_INTERVAL_MS) {
    await User.updateOne({ _id: decoded.userId, 'session.id': decoded.sid }, { $set: { 'session.lastSeenAt': new Date() } });
  }
  return true;
};

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // Fallback to query parameter token (useful for target="_blank" media/PDF links)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  const isProgressPoll = req.originalUrl.includes('/download-progress');

  if (!isProgressPoll) {
    console.log(`[Auth Middleware] Incoming request: ${req.method} ${req.originalUrl}`);
    console.log(`[Auth Middleware] Token found in header/query: ${!!token}`);
  }

  if (!token) {
    console.warn(`[Auth Middleware] Authentication failed: No token provided for ${req.originalUrl}`);
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', async (err, decoded) => {
    if (err) {
      console.warn(`[Auth Middleware] Authentication failed: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
      if (!(await checkSession(decoded, res))) {
        console.warn(`[Auth Middleware] Session rejected for user ${decoded.userId} on ${req.originalUrl}`);
        return;
      }
    } catch (sessionErr) {
      console.error('[Auth Middleware] Session check failed:', sessionErr);
      return res.status(500).json({ error: 'Session check failed' });
    }

    req.userId = decoded.userId;
    req.sessionId = decoded.sid;
    if (!isProgressPoll) {
      console.log(`[Auth Middleware] Authentication successful. User ID: ${req.userId}`);
    }
    next();
  });
};
