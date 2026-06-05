import jwt from 'jsonwebtoken';

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

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
    if (err) {
      console.warn(`[Auth Middleware] Authentication failed: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    
    req.userId = decoded.userId;
    if (!isProgressPoll) {
      console.log(`[Auth Middleware] Authentication successful. User ID: ${req.userId}`);
    }
    next();
  });
};
