import User from '../models/User.js';
import Message from '../models/Message.js';

const isAdminEmail = (email) => {
  return [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .includes((email || '').toLowerCase());
};

const requireAdmin = async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({ error: 'Access denied: Admin only' });
    return null;
  }
  return user;
};

// Admin: send a text message to a specific user, all users, or everyone whose
// interestedCourses includes a given courseId.
export const sendMessage = async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { text, target, userId, courseId } = req.body;
    const trimmedText = (text || '').trim();
    if (!trimmedText) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    let recipientIds;
    if (target === 'user') {
      if (!userId) return res.status(400).json({ error: 'userId is required for target "user"' });
      const recipient = await User.findById(userId, '_id');
      if (!recipient) return res.status(404).json({ error: 'User not found' });
      recipientIds = [recipient._id];
    } else if (target === 'course') {
      if (!courseId) return res.status(400).json({ error: 'courseId is required for target "course"' });
      const recipients = await User.find({ interestedCourses: courseId }, '_id');
      recipientIds = recipients.map(u => u._id);
    } else if (target === 'all') {
      const recipients = await User.find({}, '_id');
      recipientIds = recipients.map(u => u._id);
    } else {
      return res.status(400).json({ error: 'target must be one of "user", "course", "all"' });
    }

    if (recipientIds.length === 0) {
      return res.status(404).json({ error: 'No matching users to send to' });
    }

    await Message.insertMany(
      recipientIds.map(recipientId => ({ recipientId, text: trimmedText }))
    );

    res.json({ sentTo: recipientIds.length });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Server error sending message' });
  }
};

// Student/admin: fetch own inbox, newest first.
export const getInbox = async (req, res) => {
  try {
    const messages = await Message.find({ recipientId: req.userId }).sort({ createdAt: -1 });
    res.json(messages);
  } catch (err) {
    console.error('Error fetching inbox:', err);
    res.status(500).json({ error: 'Server error fetching inbox' });
  }
};

export const markMessageRead = async (req, res) => {
  try {
    const message = await Message.findOneAndUpdate(
      { _id: req.params.id, recipientId: req.userId },
      { read: true },
      { new: true }
    );
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  } catch (err) {
    console.error('Error marking message read:', err);
    res.status(500).json({ error: 'Server error updating message' });
  }
};

export const deleteMessage = async (req, res) => {
  try {
    const result = await Message.deleteOne({ _id: req.params.id, recipientId: req.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Message not found' });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error deleting message:', err);
    res.status(500).json({ error: 'Server error deleting message' });
  }
};
