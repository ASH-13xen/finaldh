import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import User from '../models/User.js';
import { getLoginBlock, startSession } from '../utils/session.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// API Endpoint to send config variables to the frontend safely
export const getGoogleConfig = (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID
  });
};

// Browser-generated id kept in localStorage; anything missing or malformed gets a
// throwaway id, so it counts as a new device rather than slipping past the lock.
const readDeviceId = (req) => {
  const id = req.body?.deviceId;
  return typeof id === 'string' && /^[\w-]{8,100}$/.test(id) ? id : `anon-${crypto.randomUUID()}`;
};

// Shared tail of both login flows: enforce one active session, then issue the token.
export const completeLogin = async (req, res, user) => {
  const deviceId = readDeviceId(req);
  const block = getLoginBlock(user, deviceId);
  if (block) {
    return res.status(409).json({
      code: 'SESSION_ACTIVE',
      error: block.loggedOut
        ? `This account was just used on ${block.device}. To stop account sharing, a different device can sign in only after an hour.`
        : `This account is in use on ${block.device}. Log out there - you can sign in on this device after an hour of no activity on that one.`,
      ...block
    });
  }

  const token = await startSession(user, deviceId, req.headers['user-agent']);
  res.json({
    token,
    user: {
      name: user.name,
      email: user.email,
      picture: user.picture,
      fullName: user.fullName,
      mobileNumber: user.mobileNumber,
      telegramUsername: user.telegramUsername,
      interestedCourses: user.interestedCourses,
      isAdmin: isAdminEmail(user.email)
    }
  });
};

// Verify Google Token Endpoint
export const verifyGoogleToken = async (req, res) => {
  const { credential } = req.body;
  
  if (!credential) {
    return res.status(400).json({ error: 'No Google credential token provided' });
  }

  let ticket;
  try {
    // Verify the Google ID token
    ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
  } catch (googleError) {
    console.error('Google token verification failed:', googleError);
    return res.status(401).json({ error: 'Invalid Google token' });
  }

  try {
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Find user by email to match Google mail with DB email
    let user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      // Link Google ID if not set or matches imported format
      user.googleId = googleId;
      user.name = name;
      if (picture) user.picture = picture;
      if (!user.fullName) {
        user.fullName = name;
      }
      await user.save();
    } else {
      // Create a brand new user
      user = await User.create({ 
        googleId, 
        email: email.toLowerCase(), 
        name, 
        fullName: name, 
        picture 
      });
    }

    await completeLogin(req, res, user);
  } catch (dbError) {
    console.error('Database error during Google verification:', dbError);
    res.status(500).json({ error: 'Database connection/timeout error. Please verify database connectivity.' });
  }
};

// Mock Login for local testing/development
export const mockLogin = async (req, res) => {
  try {
    let user = await User.findOne({ email: 'dev@example.com' });
    if (!user) {
      user = await User.create({
        googleId: 'mock_google_id_123',
        email: 'dev@example.com',
        name: 'Developer User',
        fullName: 'Developer User',
        picture: ''
      });
    }

    await completeLogin(req, res, user);
  } catch (err) {
    console.error('Mock login database error:', err);
    res.status(500).json({ error: 'Database error during mock login.' });
  }
};

// Ends this device's session. The account's lastSeenAt stays, so another device still
// has to wait out the switch lock (see utils/session.js).
export const logout = async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.userId, 'session.id': req.sessionId },
      { $set: { 'session.id': null, 'session.lastSeenAt': new Date() } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
};

// Heartbeat target: the auth middleware already validated and refreshed the session.
export const getSession = (req, res) => {
  res.json({ ok: true });
};
