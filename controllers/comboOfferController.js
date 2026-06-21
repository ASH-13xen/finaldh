import ComboOffer from '../models/ComboOffer.js';
import Course from '../models/Course.js';
import User from '../models/User.js';

const isAdminUser = (user) =>
  [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map((e) => e.toLowerCase())
    .includes((user?.email || '').toLowerCase());

const resolveCourses = async (courseIds) => {
  const courses = await Course.find({ courseId: { $in: courseIds } });
  const byId = new Map(courses.map((c) => [c.courseId, c]));
  return courseIds.map((id) => byId.get(id)).filter(Boolean);
};

const validateComboPayload = async (body) => {
  const label = (body.label || '').trim();
  const eligibleCourseIds = Array.isArray(body.eligibleCourseIds) ? body.eligibleCourseIds : [];
  const requiredCourseIds = Array.isArray(body.requiredCourseIds) ? body.requiredCourseIds : [];
  const pickCount = Number(body.pickCount);
  const price = Number(body.price);

  if (!label) return { error: 'Label is required' };
  if (eligibleCourseIds.length === 0) return { error: 'At least one eligible course is required' };
  if (!Number.isInteger(pickCount) || pickCount < 1 || pickCount > eligibleCourseIds.length) {
    return { error: `Pick count must be an integer between 1 and ${eligibleCourseIds.length}` };
  }
  if (!Number.isFinite(price) || price <= 0) return { error: 'Price must be a positive number' };

  const overlap = eligibleCourseIds.filter((id) => requiredCourseIds.includes(id));
  if (overlap.length > 0) return { error: `Required courses cannot overlap with eligible courses: ${overlap.join(', ')}` };

  const eligibleCourses = await resolveCourses(eligibleCourseIds);
  if (eligibleCourses.length !== eligibleCourseIds.length) {
    return { error: 'One or more eligible course IDs do not exist' };
  }
  if (requiredCourseIds.length > 0) {
    const requiredCourses = await resolveCourses(requiredCourseIds);
    if (requiredCourses.length !== requiredCourseIds.length) {
      return { error: 'One or more required course IDs do not exist' };
    }
  }

  return { value: { label, eligibleCourseIds, requiredCourseIds, pickCount, price } };
};

const attachResolvedCourses = async (offer) => {
  const eligibleCourses = await resolveCourses(offer.eligibleCourseIds);
  const requiredCourses = await resolveCourses(offer.requiredCourseIds);
  return {
    ...offer.toObject(),
    eligibleCourses: eligibleCourses.map((c) => ({ courseId: c.courseId, name: c.name, price: c.useDiscount ? c.discountedPrice : c.price })),
    requiredCourses: requiredCourses.map((c) => ({ courseId: c.courseId, name: c.name, price: c.useDiscount ? c.discountedPrice : c.price }))
  };
};

export const listActiveComboOffers = async (req, res) => {
  try {
    const offers = await ComboOffer.find({ active: true }).sort({ price: 1 });
    const resolved = await Promise.all(offers.map(attachResolvedCourses));
    res.json({ comboOffers: resolved });
  } catch (err) {
    console.error('Error listing active combo offers:', err);
    res.status(500).json({ error: 'Server error retrieving combo offers' });
  }
};

export const listComboOffers = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !isAdminUser(user)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const offers = await ComboOffer.find({}).sort({ createdAt: -1 });
    const resolved = await Promise.all(offers.map(attachResolvedCourses));
    res.json({ comboOffers: resolved });
  } catch (err) {
    console.error('Error listing combo offers:', err);
    res.status(500).json({ error: 'Server error retrieving combo offers' });
  }
};

export const createComboOffer = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !isAdminUser(user)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const { error, value } = await validateComboPayload(req.body);
    if (error) return res.status(400).json({ error });

    const offer = new ComboOffer(value);
    await offer.save();
    res.json({ message: 'Combo offer created', comboOffer: await attachResolvedCourses(offer) });
  } catch (err) {
    console.error('Error creating combo offer:', err);
    res.status(500).json({ error: 'Server error creating combo offer' });
  }
};

export const updateComboOffer = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !isAdminUser(user)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const offer = await ComboOffer.findById(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Combo offer not found' });

    // Active-only toggle path (no need to re-validate the full payload)
    if (Object.keys(req.body).length === 1 && typeof req.body.active === 'boolean') {
      offer.active = req.body.active;
      await offer.save();
      return res.json({ message: 'Combo offer updated', comboOffer: await attachResolvedCourses(offer) });
    }

    const { error, value } = await validateComboPayload(req.body);
    if (error) return res.status(400).json({ error });

    Object.assign(offer, value);
    if (typeof req.body.active === 'boolean') offer.active = req.body.active;
    await offer.save();

    res.json({ message: 'Combo offer updated', comboOffer: await attachResolvedCourses(offer) });
  } catch (err) {
    console.error('Error updating combo offer:', err);
    res.status(500).json({ error: 'Server error updating combo offer' });
  }
};

export const deleteComboOffer = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !isAdminUser(user)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const offer = await ComboOffer.findByIdAndDelete(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Combo offer not found' });

    res.json({ message: 'Combo offer deleted' });
  } catch (err) {
    console.error('Error deleting combo offer:', err);
    res.status(500).json({ error: 'Server error deleting combo offer' });
  }
};
