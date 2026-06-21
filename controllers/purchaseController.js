import PurchaseRequest from '../models/PurchaseRequest.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
import ComboOffer from '../models/ComboOffer.js';

// Create a new purchase request for a single course
export const createPurchaseRequest = async (req, res) => {
  const { courseId, comboOfferId, upiTxnId } = req.body;
  const screenshotFile = req.file;

  if (!courseId && !comboOfferId) {
    return res.status(400).json({ error: 'Course ID is required' });
  }
  if (!screenshotFile) {
    return res.status(400).json({ error: 'Payment screenshot is required' });
  }

  const cleanedTxnId = upiTxnId ? upiTxnId.trim() : '';

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((user.email || '').toLowerCase());
    if (isAdmin) {
      return res.status(400).json({ error: 'Admins do not need to purchase courses' });
    }

    if (cleanedTxnId) {
      // Check if the UPI transaction ID has already been used (case-insensitive check)
      const existingTxn = await PurchaseRequest.findOne({
        upiTxnId: { $regex: new RegExp(`^${cleanedTxnId}$`, 'i') }
      });
      if (existingTxn) {
        return res.status(400).json({ error: 'This UPI Transaction ID has already been submitted' });
      }
    }

    // screenshotUrl should be relative path from backend/ uploads statically served directory
    const screenshotUrl = `/uploads/screenshots/${screenshotFile.filename}`;

    if (comboOfferId) {
      return await createComboPurchaseRequest({ req, res, user, comboOfferId, screenshotUrl, cleanedTxnId });
    }

    // Find the course by custom courseId
    const course = await Course.findOne({ courseId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if course is already in student's interestedCourses
    const hasPurchased = user.interestedCourses.some(
      (cId) => cId.toLowerCase() === courseId.toLowerCase()
    );
    if (hasPurchased) {
      return res.status(400).json({ error: 'You have already purchased this course' });
    }

    // Check if there is already a pending purchase request for this course by this student
    const existingPending = await PurchaseRequest.findOne({
      userId: req.userId,
      courseId,
      status: 'pending'
    });
    if (existingPending) {
      return res.status(400).json({ error: 'You already have a pending purchase request for this course' });
    }

    const newRequest = new PurchaseRequest({
      userId: user._id,
      userEmail: user.email,
      userName: user.fullName || user.name,
      courseObjectId: course._id,
      courseId: course.courseId,
      courseName: course.name,
      price: course.useDiscount ? course.discountedPrice : course.price,
      courses: [course._id],
      screenshotUrl,
      upiTxnId: cleanedTxnId || undefined,
      status: 'pending'
    });

    await newRequest.save();

    res.json({
      message: 'Purchase request submitted successfully. It will be verified within 6-8 hours.',
      request: newRequest
    });
  } catch (err) {
    console.error('Error creating purchase request:', err);
    res.status(500).json({ error: 'Server error submitting purchase request' });
  }
};

// Create a new purchase request for a combo offer (multiple courses, one flat price)
const createComboPurchaseRequest = async ({ req, res, user, comboOfferId, screenshotUrl, cleanedTxnId }) => {
  const comboOffer = await ComboOffer.findById(comboOfferId);
  if (!comboOffer || !comboOffer.active) {
    return res.status(404).json({ error: 'Combo offer not found' });
  }

  let selectedCourseIds = [];
  try {
    selectedCourseIds = JSON.parse(req.body.selectedCourseIds || '[]');
  } catch {
    return res.status(400).json({ error: 'Invalid selectedCourseIds payload' });
  }

  if (!Array.isArray(selectedCourseIds) || selectedCourseIds.length !== comboOffer.pickCount) {
    return res.status(400).json({ error: `You must select exactly ${comboOffer.pickCount} course(s) for this combo` });
  }

  const uniqueSelected = new Set(selectedCourseIds);
  if (uniqueSelected.size !== selectedCourseIds.length) {
    return res.status(400).json({ error: 'Duplicate courses selected' });
  }

  const invalidSelection = selectedCourseIds.some((id) => !comboOffer.eligibleCourseIds.includes(id));
  if (invalidSelection) {
    return res.status(400).json({ error: 'Selected course is not eligible for this combo' });
  }

  const finalCourseIds = [...selectedCourseIds, ...comboOffer.requiredCourseIds];
  const courseDocs = await Course.find({ courseId: { $in: finalCourseIds } });
  if (courseDocs.length !== finalCourseIds.length) {
    return res.status(404).json({ error: 'One or more courses in this combo are no longer available' });
  }

  const alreadyOwned = finalCourseIds.some((id) =>
    user.interestedCourses.some((cId) => cId.toLowerCase() === id.toLowerCase())
  );
  if (alreadyOwned) {
    return res.status(400).json({ error: 'You already have access to one or more courses in this combo' });
  }

  const existingPending = await PurchaseRequest.findOne({
    userId: req.userId,
    comboOffer: comboOffer._id,
    status: 'pending'
  });
  if (existingPending) {
    return res.status(400).json({ error: 'You already have a pending purchase request for this combo' });
  }

  const newRequest = new PurchaseRequest({
    userId: user._id,
    userEmail: user.email,
    userName: user.fullName || user.name,
    courseObjectId: courseDocs[0]._id,
    courseId: courseDocs.map((c) => c.courseId).join(','),
    courseName: comboOffer.label,
    price: comboOffer.price,
    courses: courseDocs.map((c) => c._id),
    comboOffer: comboOffer._id,
    screenshotUrl,
    upiTxnId: cleanedTxnId || undefined,
    status: 'pending'
  });

  await newRequest.save();

  res.json({
    message: 'Purchase request submitted successfully. It will be verified within 6-8 hours.',
    request: newRequest
  });
};

// Retrieve purchase requests for the logged-in student
export const getStudentPurchaseRequests = async (req, res) => {
  try {
    const requests = await PurchaseRequest.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .populate('courses', 'name courseId')
      .populate('comboOffer', 'label price');
    res.json(requests);
  } catch (err) {
    console.error('Error fetching student purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
  }
};

// Retrieve all purchase requests for admin
export const getAdminPurchaseRequests = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((user.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const requests = await PurchaseRequest.find({})
      .sort({ createdAt: -1 })
      .populate('courses', 'name courseId')
      .populate('comboOffer', 'label price');
    res.json(requests);
  } catch (err) {
    console.error('Error fetching admin purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
  }
};

// Approve a purchase request (Admin only)
export const approvePurchaseRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await PurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been processed (Status: ${request.status})` });
    }

    const targetUser = await User.findById(request.userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Student user not found' });
    }

    // Resolve every course covered by this request (combo = multiple, legacy/single = one)
    const courseObjectIds = (request.courses && request.courses.length > 0)
      ? request.courses
      : [request.courseObjectId];
    const coursesInRequest = await Course.find({ _id: { $in: courseObjectIds } });

    for (const course of coursesInRequest) {
      // Add custom courseId to interestedCourses if not already there
      if (!targetUser.interestedCourses.includes(course.courseId)) {
        targetUser.interestedCourses.push(course.courseId);
      }

      // Add courseObjectId to purchasedCourses if not already there
      if (!targetUser.purchasedCourses.some((id) => id.equals(course._id))) {
        targetUser.purchasedCourses.push(course._id);
      }

      // Pre-initialize downloadLimit configuration for this course.
      // If course has multiple PDFs, initialize separate limits for each PDF (using courseId_index composite keys).
      const fileCount = (course.fileUrls && course.fileUrls.length > 0) ? course.fileUrls.length : 1;

      for (let i = 0; i < fileCount; i++) {
        const compositeCourseId = fileCount > 1 ? `${course.courseId}_${i}` : course.courseId;
        const existingLimit = targetUser.downloadLimits.find(d => d.courseId.toLowerCase() === compositeCourseId.toLowerCase());
        if (!existingLimit) {
          targetUser.downloadLimits.push({
            courseId: compositeCourseId,
            downloadedCount: 0,
            allowedCount: 1
          });
        }
      }
    }

    request.status = 'approved';

    await targetUser.save();
    await request.save();

    res.json({
      message: 'Purchase request approved successfully! Course added to student profile.',
      request
    });
  } catch (err) {
    console.error('Error approving purchase request:', err);
    res.status(500).json({ error: 'Server error approving purchase request' });
  }
};

// Reject a purchase request (Admin only)
export const rejectPurchaseRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await PurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been processed (Status: ${request.status})` });
    }

    request.status = 'rejected';
    await request.save();

    res.json({
      message: 'Purchase request rejected successfully.',
      request
    });
  } catch (err) {
    console.error('Error rejecting purchase request:', err);
    res.status(500).json({ error: 'Server error rejecting purchase request' });
  }
};

// Track Telegram notification clicks (limit to twice per student purchase request)
export const trackTelegramNotification = async (req, res) => {
  const { id } = req.params;

  try {
    const request = await PurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    // Ensure user owns this request
    if (request.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Access denied: You do not own this purchase request' });
    }

    if (request.telegramNotificationCount >= 2) {
      return res.status(400).json({ error: 'Notification limit reached' });
    }

    request.telegramNotificationCount = (request.telegramNotificationCount || 0) + 1;
    await request.save();

    res.json({
      success: true,
      telegramNotificationCount: request.telegramNotificationCount,
      request
    });
  } catch (err) {
    console.error('Error tracking telegram notification:', err);
    res.status(500).json({ error: 'Server error tracking telegram notification' });
  }
};
