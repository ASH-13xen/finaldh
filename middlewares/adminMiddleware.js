import User from '../models/User.js';

// Single source of truth for "is this email an admin". Several older controllers still carry their
// own copy of this list; new code should import it from here.
export const isAdminEmail = (email) => {
  return [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map((e) => e.toLowerCase())
    .includes((email || '').toLowerCase());
};

// Express middleware: must run after authenticateToken (needs req.userId).
export const requireAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !isAdminEmail(user.email)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }
    req.adminUser = user;
    next();
  } catch (err) {
    console.error('[requireAdmin] error:', err);
    res.status(500).json({ error: 'Server error verifying admin access' });
  }
};
