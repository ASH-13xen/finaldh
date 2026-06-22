import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';
import DownloadRequest from '../models/DownloadRequest.js';
import bwipjs from 'bwip-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get authenticated user profile details
export const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ 
      name: user.name, 
      fullName: user.fullName || user.name,
      email: user.email, 
      picture: user.picture,
      optionalSubject: user.optionalSubject,
      completedTopics: user.completedTopics,
      mobileNumber: user.mobileNumber,
      telegramUsername: user.telegramUsername,
      interestedCourses: user.interestedCourses,
      downloadLimits: user.downloadLimits || [],
      isAdmin: [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((user.email || '').toLowerCase())
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

// Update authenticated user profile details
export const updateUserProfile = async (req, res) => {
  const { fullName, mobileNumber, telegramUsername, interestedCourses } = req.body;
  try {
    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (mobileNumber !== undefined) updateData.mobileNumber = mobileNumber;
    if (telegramUsername !== undefined) updateData.telegramUsername = telegramUsername;
    if (interestedCourses !== undefined) updateData.interestedCourses = interestedCourses;

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: updateData },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    res.json({
      name: user.name,
      fullName: user.fullName || user.name,
      email: user.email,
      picture: user.picture,
      optionalSubject: user.optionalSubject,
      completedTopics: user.completedTopics,
      mobileNumber: user.mobileNumber,
      telegramUsername: user.telegramUsername,
      interestedCourses: user.interestedCourses,
      downloadLimits: user.downloadLimits || []
    });
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Update Optional Subject Preference
export const updateOptionalSubject = async (req, res) => {
  const { optionalSubject } = req.body;
  try {
    const user = await User.findByIdAndUpdate(
      req.userId,
      { optionalSubject },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ optionalSubject: user.optionalSubject });
  } catch (error) {
    console.error('Error updating optional subject:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Toggle progress of a syllabus topic
export const toggleTopicProgress = async (req, res) => {
  const { topicKey, completed } = req.body;

  if (!topicKey) {
    return res.status(400).json({ error: 'topicKey is required' });
  }

  try {
    const update = completed 
      ? { $addToSet: { completedTopics: topicKey } }
      : { $pull: { completedTopics: topicKey } };

    const user = await User.findByIdAndUpdate(
      req.userId,
      update,
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ completedTopics: user.completedTopics });
  } catch (error) {
    console.error('Error toggling topic progress:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Get the user's filtered syllabus structure based on their optional subject
export const getUserSyllabus = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Load static syllabus JSON
    const syllabusPath = path.join(__dirname, '../syllabus_hierarchy.json');
    const fileContent = await fs.readFile(syllabusPath, 'utf8');
    const fullSyllabus = JSON.parse(fileContent);

    // Get GS modules (they are always mandatory)
    const gsModules = fullSyllabus.gsModules || {};

    // Get selected optional subject
    const selectedOptional = user.optionalSubject;
    let optionalData = null;

    if (selectedOptional && fullSyllabus.optionalSubjects) {
      optionalData = fullSyllabus.optionalSubjects[selectedOptional] || null;
    }

    res.json({
      optionalSubject: selectedOptional,
      completedTopics: user.completedTopics,
      gsModules,
      optionalData
    });
  } catch (error) {
    console.error('Error loading user syllabus:', error);
    res.status(500).json({ error: 'Server error loading syllabus' });
  }
};

// Track student download and increment downloadedCount
export const trackDownload = async (req, res) => {
  const { courseId } = req.body;
  if (!courseId) {
    return res.status(400).json({ error: 'courseId is required' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let limitEntry = user.downloadLimits.find(d => d.courseId.toLowerCase() === courseId.toLowerCase());

    if (limitEntry) {
      if (limitEntry.downloadedCount >= limitEntry.allowedCount) {
        return res.status(400).json({ error: 'Download limit reached for this course' });
      }
      limitEntry.downloadedCount += 1;
    } else {
      user.downloadLimits.push({
        courseId,
        downloadedCount: 1,
        allowedCount: 1
      });
    }

    await user.save();
    res.json({ success: true, downloadLimits: user.downloadLimits });
  } catch (error) {
    console.error('Error tracking download:', error);
    res.status(500).json({ error: 'Server error tracking download' });
  }
};

// Request additional download permission
export const requestAdditionalDownload = async (req, res) => {
  const { courseId, courseName, reason } = req.body;
  if (!courseId || !courseName) {
    return res.status(400).json({ error: 'courseId and courseName are required' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'Reason is required and cannot be empty' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if there is already a pending request
    const existingRequest = await DownloadRequest.findOne({
      user: req.userId,
      courseId,
      status: 'pending'
    });

    if (existingRequest) {
      return res.status(400).json({ error: 'You already have a pending request for this course' });
    }

    const newRequest = new DownloadRequest({
      user: req.userId,
      userEmail: user.email,
      userName: user.fullName || user.name,
      courseId,
      courseName,
      reason: reason.trim(),
      status: 'pending'
    });

    await newRequest.save();
    res.json({ success: true, message: 'Request submitted successfully' });
  } catch (error) {
    console.error('Error requesting download:', error);
    res.status(500).json({ error: 'Server error requesting download' });
  }
};

// Get all pending download requests (Admin only)
export const getPendingDownloadRequests = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((user.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const requests = await DownloadRequest.find({ status: 'pending' }).sort({ createdAt: -1 });
    res.json(requests);
  } catch (error) {
    console.error('Error fetching pending requests:', error);
    res.status(500).json({ error: 'Server error fetching pending requests' });
  }
};

// Approve a download request (Admin only)
export const approveDownloadRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) return res.status(404).json({ error: 'Admin user not found' });

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await DownloadRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Download request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request is already processed' });
    }

    const targetUser = await User.findById(request.user);
    if (!targetUser) {
      return res.status(404).json({ error: 'Target student user not found' });
    }

    let limitEntry = targetUser.downloadLimits.find(d => d.courseId.toLowerCase() === request.courseId.toLowerCase());
    if (limitEntry) {
      limitEntry.allowedCount += 1;
    } else {
      targetUser.downloadLimits.push({
        courseId: request.courseId,
        downloadedCount: 0,
        allowedCount: 2
      });
    }

    request.status = 'approved';
    
    await targetUser.save();
    await request.save();

    res.json({ success: true, message: 'Request approved successfully' });
  } catch (error) {
    console.error('Error approving request:', error);
    res.status(500).json({ error: 'Server error approving request' });
  }
};

// Get the logged-in user's download requests
export const getUserDownloadRequests = async (req, res) => {
  try {
    const requests = await DownloadRequest.find({ user: req.userId });
    res.json(requests);
  } catch (error) {
    console.error('Error fetching user download requests:', error);
    res.status(500).json({ error: 'Server error fetching requests' });
  }
};

// Generate and return Code 128 barcode of user ID
export const getUserBarcode = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    bwipjs.toBuffer({
      bcid: 'code128',
      text: user._id.toString(),
      scale: 2,
      height: 10,
      includetext: true,
      textxalign: 'center',
    }, function (err, png) {
      if (err) {
        console.error('Error generating barcode:', err);
        return res.status(500).json({ error: 'Failed to generate barcode' });
      }
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    });
  } catch (error) {
    console.error('Error generating barcode:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Complete purchase profile gate (saves name, telegram, and verified phone)
export const completePurchaseProfile = async (req, res) => {
  try {
    const { firstName, lastName, telegramUsername, mobileNumber } = req.body;
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const updates = {};

    // 1. Verify and Update Name (Always allow updating name)
    if (!firstName || !firstName.trim() || !lastName || !lastName.trim()) {
      return res.status(400).json({ error: 'Both First Name and Last Name must be provided.' });
    }
    updates.fullName = `${firstName.trim()} ${lastName.trim()}`;

    // 2. Verify and Update Telegram (Always allow updating telegram)
    if (!telegramUsername || !telegramUsername.trim()) {
      return res.status(400).json({ error: 'Telegram username is required.' });
    }
    updates.telegramUsername = telegramUsername.trim();

    // 3. Save Phone (only if not already verified/saved in the DB)
    const isPhoneAlreadyVerified = !!(user.mobileNumber && user.mobileNumber.trim());
    if (!isPhoneAlreadyVerified) {
      if (!mobileNumber || !mobileNumber.trim()) {
        return res.status(400).json({ error: 'Phone number is required.' });
      }
      updates.mobileNumber = mobileNumber.trim();
    }

    // Apply updates if any
    let updatedUser = user;
    if (Object.keys(updates).length > 0) {
      updatedUser = await User.findByIdAndUpdate(
        req.userId,
        { $set: updates },
        { new: true }
      );
    }

    res.json({
      success: true,
      user: {
        name: updatedUser.name,
        fullName: updatedUser.fullName || updatedUser.name,
        email: updatedUser.email,
        picture: updatedUser.picture,
        optionalSubject: updatedUser.optionalSubject,
        completedTopics: updatedUser.completedTopics,
        mobileNumber: updatedUser.mobileNumber,
        telegramUsername: updatedUser.telegramUsername,
        interestedCourses: updatedUser.interestedCourses,
        downloadLimits: updatedUser.downloadLimits || [],
        isAdmin: [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((updatedUser.email || '').toLowerCase())
      }
    });
  } catch (error) {
    console.error('Error completing purchase profile:', error);
    res.status(500).json({ error: 'Server error saving profile details' });
  }
};

// Retrieve all users in the system (Admin only)
export const listAllUsers = async (req, res) => {
  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) return res.status(404).json({ error: 'Admin user not found' });

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const users = await User.find({}).sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    console.error('Error fetching all users by admin:', error);
    res.status(500).json({ error: 'Server error retrieving user list' });
  }
};

// Update any field of any user (Admin only)
export const adminUpdateUserProfile = async (req, res) => {
  const { id } = req.params;
  const { fullName, name, email, mobileNumber, telegramUsername, interestedCourses, optionalSubject, downloadLimits } = req.body;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) return res.status(404).json({ error: 'Admin user not found' });

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const targetUser = await User.findById(id);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (fullName !== undefined) targetUser.fullName = fullName;
    if (name !== undefined) targetUser.name = name;
    if (email !== undefined) targetUser.email = email;
    if (mobileNumber !== undefined) targetUser.mobileNumber = mobileNumber;
    if (telegramUsername !== undefined) targetUser.telegramUsername = telegramUsername;
    if (interestedCourses !== undefined) targetUser.interestedCourses = interestedCourses;
    if (optionalSubject !== undefined) targetUser.optionalSubject = optionalSubject;
    if (downloadLimits !== undefined) targetUser.downloadLimits = downloadLimits;

    await targetUser.save();
    res.json({ success: true, user: targetUser });
  } catch (error) {
    console.error('Error updating user profile by admin:', error);
    res.status(500).json({ error: 'Server error updating user profile' });
  }
};
