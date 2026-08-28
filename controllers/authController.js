import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// API Endpoint to send config variables to the frontend safely
export const getGoogleConfig = (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID
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

    // Generate our own JWT for session management
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

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
        isAdmin: [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((user.email || '').toLowerCase())
      }
    });
  } catch (dbError) {
    console.error('Database error during Google verification:', dbError);
    res.status(500).json({ error: 'Database connection/timeout error. Please verify database connectivity.' });
  }
};

// Mock Login for local testing/development.
// Disabled unless ALLOW_DEV_LOGIN=true so it can never be hit in production.
// Optionally accepts { email } in the body so you can sign in directly as your
// admin email (see ADMIN_EMAIL) instead of the default dev@example.com.
export const mockLogin = async (req, res) => {
  if (process.env.ALLOW_DEV_LOGIN !== 'true') {
    return res.status(403).json({ error: 'Dev login is disabled. Set ALLOW_DEV_LOGIN=true in the backend .env to enable it.' });
  }
  try {
    const rawEmail = (req.body?.email || 'dev@example.com').toLowerCase().trim();
    let user = await User.findOne({ email: rawEmail });
    if (!user) {
      user = await User.create({
        googleId: `mock_${Date.now()}`,
        email: rawEmail,
        name: rawEmail.split('@')[0],
        fullName: rawEmail.split('@')[0],
        picture: ''
      });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

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
        isAdmin: [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((user.email || '').toLowerCase())
      }
    });
  } catch (err) {
    console.error('Mock login database error:', err);
    res.status(500).json({ error: 'Database error during mock login.' });
  }
};
